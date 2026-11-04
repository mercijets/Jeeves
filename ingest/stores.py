"""Where indexed content goes.

CloudStore writes to Cloudflare (R2 for files/images, D1 for metadata + text,
Vectorize for embeddings, Workers AI for embedding). LocalStore writes the same
data to a local SQLite file and folder so the pipeline can be tested offline.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from pathlib import Path

import requests

EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"   # 768 dimensions
EMBED_BATCH = 50
D1_BATCH_ROWS = 40


def sql_lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(v))
    return "'" + s.replace("'", "''") + "'"


def insert_sql(table: str, row: dict, replace: bool = True) -> str:
    cols = ",".join(row)
    vals = ",".join(sql_lit(v) for v in row.values())
    verb = "INSERT OR REPLACE" if replace else "INSERT"
    return f"{verb} INTO {table} ({cols}) VALUES ({vals});"


def delete_doc_sql(drive_id: str) -> list[str]:
    d = sql_lit(drive_id)
    return [
        f"DELETE FROM chunks WHERE drive_id={d};",
        f"DELETE FROM pages WHERE drive_id={d};",
        f"DELETE FROM tc_overrides WHERE drive_id={d};",
    ]


class Store:
    def known_documents(self) -> dict[str, dict]: ...
    def chunk_ids(self, drive_id: str) -> list[str]: ...
    def run_sql(self, statements: list[str]) -> None: ...
    def put_object(self, key: str, data: bytes, content_type: str) -> None: ...
    def embed(self, texts: list[str]) -> list[list[float]]: ...
    def vectors_upsert(self, items: list[dict]) -> None: ...
    def vectors_delete(self, ids: list[str]) -> None: ...


# --------------------------------------------------------------------------- local

class LocalStore(Store):
    def __init__(self, root: str):
        self.root = Path(root)
        (self.root / "r2").mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "jeeves.sqlite")
        self.db.executescript((Path(__file__).parent.parent / "schema.sql").read_text())
        self.vec_path = self.root / "vectors.jsonl"

    def known_documents(self):
        cur = self.db.execute("SELECT drive_id, md5, active FROM documents")
        return {r[0]: {"md5": r[1], "active": r[2]} for r in cur}

    def chunk_ids(self, drive_id):
        return [r[0] for r in self.db.execute("SELECT id FROM chunks WHERE drive_id=?", (drive_id,))]

    def run_sql(self, statements):
        self.db.executescript("\n".join(statements))
        self.db.commit()

    def put_object(self, key, data, content_type):
        p = self.root / "r2" / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def embed(self, texts):
        # Deterministic stand-in so the pipeline runs offline.
        out = []
        for t in texts:
            h = hashlib.sha256(t.encode()).digest()
            out.append([b / 255 for b in (h * 24)[:768]])
        return out

    def vectors_upsert(self, items):
        with self.vec_path.open("a") as f:
            for it in items:
                f.write(json.dumps({"id": it["id"], "metadata": it["metadata"]}) + "\n")

    def vectors_delete(self, ids):
        pass


# --------------------------------------------------------------------------- cloud

class CloudStore(Store):
    """Needs env: CF_ACCOUNT_ID, CF_API_TOKEN, D1_DATABASE_ID, VECTORIZE_INDEX,
    R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."""

    def __init__(self):
        import boto3  # only needed in the cloud
        from botocore.config import Config
        e = os.environ
        self.acct = e["CF_ACCOUNT_ID"]
        self.api = f"https://api.cloudflare.com/client/v4/accounts/{self.acct}"
        self.h = {"Authorization": f"Bearer {e['CF_API_TOKEN']}"}
        self.d1 = e["D1_DATABASE_ID"]
        self.index = e["VECTORIZE_INDEX"]
        self.bucket = e["R2_BUCKET"]
        self.s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{self.acct}.r2.cloudflarestorage.com",
            aws_access_key_id=e["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=e["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(retries={"max_attempts": 10, "mode": "adaptive"}, connect_timeout=30, read_timeout=120),
        )

    def _post(self, path, **kw):
        extra = kw.pop("headers", {})
        for attempt in range(6):
            try:
                r = requests.post(self.api + path, headers={**self.h, **extra}, timeout=180, **kw)
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (408, 429, 500, 502, 503, 504):
                time.sleep(2 ** attempt)
                continue
            if not r.ok:
                raise RuntimeError(f"{path} -> {r.status_code}: {r.text[:500]}")
            body = r.json()
            if not body.get("success", True):
                raise RuntimeError(f"{path} -> {body.get('errors')}")
            return body
        raise RuntimeError(f"{path} kept failing")

    def _d1(self, sql: str, params=None):
        payload = {"sql": sql}
        if params:
            payload["params"] = params
        return self._post(f"/d1/database/{self.d1}/query", json=payload)["result"]

    def known_documents(self):
        rows = self._d1("SELECT drive_id, md5, active FROM documents")[0]["results"]
        return {r["drive_id"]: {"md5": r["md5"], "active": r["active"]} for r in rows}

    def chunk_ids(self, drive_id):
        rows = self._d1("SELECT id FROM chunks WHERE drive_id=?", [drive_id])[0]["results"]
        return [r["id"] for r in rows]

    def run_sql(self, statements):
        batch, size = [], 0
        for s in statements:
            if batch and (len(batch) >= D1_BATCH_ROWS or size + len(s) > 90_000):
                self._d1("\n".join(batch))
                batch, size = [], 0
            batch.append(s)
            size += len(s)
        if batch:
            self._d1("\n".join(batch))

    def put_object(self, key, data, content_type):
        for attempt in range(5):
            try:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)
                return
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)

    def embed(self, texts):
        out = []
        for i in range(0, len(texts), EMBED_BATCH):
            res = self._post(f"/ai/run/{EMBED_MODEL}", json={"text": [t[:2000] for t in texts[i:i + EMBED_BATCH]]})
            out.extend(res["result"]["data"])
        return out

    def vectors_upsert(self, items):
        for i in range(0, len(items), 500):
            body = "\n".join(json.dumps(it) for it in items[i:i + 500])
            self._post(f"/vectorize/v2/indexes/{self.index}/upsert",
                       data=body.encode(), headers={"Content-Type": "application/x-ndjson"})

    def vectors_delete(self, ids):
        for i in range(0, len(ids), 500):
            self._post(f"/vectorize/v2/indexes/{self.index}/delete_by_ids", json={"ids": ids[i:i + 500]})
