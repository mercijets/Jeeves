"""Sync the Jeeves Library shared drive into the Jeeves index.

    python -m ingest.sync                      # Drive -> Cloudflare (GitHub Actions)
    python -m ingest.sync --local ./out --source ./folder   # offline test

Only changed files (by Drive md5) are re-indexed. Files moved to _Archive or
_Review, or deleted, are deactivated and their vectors removed. A summary is
posted to Slack #jeeves-updates when SLACK_UPDATES_WEBHOOK is set.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .extract import extract
from .library import classify, should_index
from .stores import CloudStore, LocalStore, Store, delete_doc_sql, insert_sql, sql_lit


# --------------------------------------------------------------------------- sources

class DriveSource:
    """Read-only access to the shared drive through a service account."""

    def __init__(self):
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/drive.readonly"])
        self.svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        self.drive_id = os.environ["JEEVES_SHARED_DRIVE_ID"]

    def list_files(self) -> list[dict]:
        items, token = [], None
        while True:
            r = self.svc.files().list(
                corpora="drive", driveId=self.drive_id, includeItemsFromAllDrives=True,
                supportsAllDrives=True, q="trashed=false", pageSize=1000, pageToken=token,
                fields="nextPageToken, files(id,name,mimeType,parents,md5Checksum,modifiedTime)",
            ).execute()
            items += r["files"]
            token = r.get("nextPageToken")
            if not token:
                break
        folders = {f["id"]: f for f in items if f["mimeType"] == "application/vnd.google-apps.folder"}

        def path_of(fid: str) -> str:
            parts, cur = [], folders.get(fid)
            while cur:
                parts.append(cur["name"])
                cur = folders.get((cur.get("parents") or [None])[0])
            return "/".join(reversed(parts))

        out = []
        for f in items:
            if f["mimeType"] == "application/vnd.google-apps.folder":
                continue
            out.append({"id": f["id"], "name": f["name"], "md5": f.get("md5Checksum"),
                        "path": path_of((f.get("parents") or [""])[0])})
        return out

    def download(self, fid: str) -> bytes:
        return self.svc.files().get_media(fileId=fid, supportsAllDrives=True).execute()


class FolderSource:
    """A local copy of the library (for testing). File id = relative path."""

    def __init__(self, root: str):
        self.root = Path(root)

    def list_files(self):
        import hashlib
        out = []
        for p in self.root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(self.root)
                out.append({"id": "local-" + hashlib.md5(str(rel).encode()).hexdigest()[:20],
                            "name": p.name, "path": str(rel.parent) if str(rel.parent) != "." else "",
                            "md5": hashlib.md5(p.read_bytes()).hexdigest(), "_file": p})
        return out

    def download(self, fid):
        raise NotImplementedError  # FolderSource entries carry _file


# --------------------------------------------------------------------------- indexing

def index_file(store: Store, src, f: dict, log) -> dict:
    meta = classify(f["path"], f["name"])
    data = f["_file"].read_bytes() if "_file" in f else src.download(f["id"])
    pages = extract(data, meta.doc_kind)
    did = f["id"]

    old_ids = store.chunk_ids(did)
    if old_ids:
        store.vectors_delete(old_ids)

    store.put_object(f"pdf/{did}.pdf", data, "application/pdf")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stmts = delete_doc_sql(did)
    row = {"drive_id": did, "name": f["name"], "path": f["path"], "md5": f["md5"],
           **{k: v for k, v in meta.row().items() if k not in ("tc_number", "tc_page")},
           "page_count": len(pages), "active": 1, "indexed_at": now}
    stmts.append(insert_sql("documents", row))

    if meta.doc_kind == "tc" and meta.tc_number and meta.tc_page:
        stmts.append(insert_sql("tc_overrides", {
            "tc_number": meta.tc_number, "afm_page": meta.tc_page,
            "drive_id": did, "effectivity": meta.effectivity}))

    vec_items, chunk_texts, chunk_meta = [], [], []
    for p in pages:
        pid = f"{did}:{p.index}"
        img_key = f"page/{did}/{p.index}.png"
        if p.png:
            store.put_object(img_key, p.png, "image/png")
        stmts.append(insert_sql("pages", {
            "id": pid, "drive_id": did, "page_index": p.index, "page_label": p.label,
            "config_code": p.config_code, "is_tc_inline": int(p.is_tc_inline),
            "image_key": img_key if p.png else None, "has_figure": int(p.has_figure)}))
        for n, (heading, text) in enumerate(p.chunks):
            cid = f"{did}:{p.index}:{n}"
            stmts.append(insert_sql("chunks", {"id": cid, "drive_id": did, "page_id": pid,
                                               "heading": heading, "text": text}, replace=False))
            # The embedded text carries the title so search can match "TCAS supplement" etc.
            chunk_texts.append(f"{meta.title}\n{heading or ''}\n{text}")
            chunk_meta.append({"id": cid, "metadata": {
                "drive_id": did, "page_id": pid, "authority": meta.authority,
                "kind": meta.doc_kind, "access": meta.access}})

    store.run_sql(stmts)
    if chunk_texts:
        vectors = store.embed(chunk_texts)
        for m, v in zip(chunk_meta, vectors):
            vec_items.append({**m, "values": v})
        store.vectors_upsert(vec_items)

    log(f"indexed {f['path']}/{f['name']}: {len(pages)} pages, {len(chunk_texts)} chunks")
    return {"title": meta.title, "revision": meta.revision, "pages": len(pages)}


def deactivate(store: Store, drive_id: str):
    ids = store.chunk_ids(drive_id)
    if ids:
        store.vectors_delete(ids)
    store.run_sql(delete_doc_sql(drive_id) +
                  [f"UPDATE documents SET active=0 WHERE drive_id={sql_lit(drive_id)};"])


def run(store: Store, src, force: bool = False, log=print) -> dict:
    files = src.list_files()
    known = store.known_documents()
    wanted = {f["id"]: f for f in files if should_index(f["path"], f["name"])}

    added, updated, removed, failed = [], [], [], []
    for fid, f in wanted.items():
        k = known.get(fid)
        if not force and k and k["md5"] == f["md5"] and k["active"]:
            continue
        try:
            info = index_file(store, src, f, log)
            (updated if k else added).append(info)
        except Exception as e:  # keep going; report at the end
            failed.append(f"{f['name']}: {e}")
            log(f"FAILED {f['name']}: {e}")

    for fid, k in known.items():
        if k["active"] and fid not in wanted:
            deactivate(store, fid)
            removed.append(fid)

    summary = {"added": added, "updated": updated, "removed": len(removed), "failed": failed,
               "total_indexed": len(wanted)}
    log(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in summary.items()}))
    return summary


def post_slack(summary: dict):
    hook = os.environ.get("SLACK_UPDATES_WEBHOOK")
    if not hook or not (summary["added"] or summary["updated"] or summary["removed"] or summary["failed"]):
        return
    import requests
    lines = [":books: *Jeeves library updated*"]
    for label, key in (("New", "added"), ("Updated", "updated")):
        for d in summary[key]:
            lines.append(f"• {label}: {d['title']}" + (f" ({d['revision']})" if d["revision"] else ""))
    if summary["removed"]:
        lines.append(f"• Retired: {summary['removed']} document(s) moved to archive or removed")
    for f in summary["failed"]:
        lines.append(f":warning: Could not index {f}")
    requests.post(hook, json={"text": "\n".join(lines)}, timeout=30)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", help="write to a local folder instead of Cloudflare")
    ap.add_argument("--source", help="read from a local folder instead of Google Drive")
    ap.add_argument("--force", action="store_true", help="re-index everything")
    a = ap.parse_args(argv)
    store = LocalStore(a.local) if a.local else CloudStore()
    src = FolderSource(a.source) if a.source else DriveSource()
    summary = run(store, src, force=a.force)
    if not a.local:
        post_slack(summary)
    sys.exit(1 if summary["failed"] else 0)


if __name__ == "__main__":
    main()
