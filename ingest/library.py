"""Rules that turn a file's folder and name in the Jeeves Library into document metadata.

The folder decides authority and default effectivity; the file name refines it
(revision, TC number, supplement number, serial range). Nothing here reads the PDF.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict

# Serial groups used everywhere in Jeeves.
#   LOW     = 750-0001..0172 NOT incorporating SB750-71-10
#   LOW_SB  = 750-0001..0172 incorporating SB750-71-10
#   HIGH    = 750-0173..0500
SERIAL_GROUP_TEXT = {
    "LOW": "SN 0001-0172 (without SB750-71-10)",
    "LOW_SB": "SN 0001-0172 with SB750-71-10",
    "HIGH": "SN 0173-0500",
}
ALL_GROUPS = ["LOW", "LOW_SB", "HIGH"]
AFM_75FMA_GROUPS = ["HIGH", "LOW_SB"]

SKIP_FOLDERS = ("_Archive", "_Review")

AUTHORITY = {
    1: "FAA Approved",
    2: "Manufacturer reference",
    3: "Merci Jets company",
    4: "Training / study aid (not authoritative)",
}


@dataclass
class DocMeta:
    family: str
    doc_kind: str
    title: str
    authority: int
    authority_label: str
    revision: str | None
    rev_date: str | None
    effectivity: str
    serial_groups: list[str]
    access: str = "all"
    tc_number: str | None = None
    tc_page: str | None = None

    def row(self) -> dict:
        d = asdict(self)
        d["serial_groups"] = json.dumps(self.serial_groups)
        return d


def should_index(path: str, name: str) -> bool:
    """Skip archive/review folders and anything that is not a PDF."""
    top = path.split("/", 1)[0] if path else ""
    if top in SKIP_FOLDERS:
        return False
    return name.lower().endswith(".pdf")


def _groups_from_name(name: str) -> list[str] | None:
    """Serial ranges spelled out in a file name override the folder default."""
    n = name.upper()
    if "SN0001-0172" in n:
        return ["LOW", "LOW_SB"] if "NON-SPLIT" in n or "OM_75OM" in n else ["LOW", "LOW_SB"]
    if "SN0173-0500" in n:
        return ["HIGH"]
    m = re.search(r"SN(\d{4})-(\d{4})", n)
    if m:  # partial range inside the high group, e.g. SN0222-0309
        return ["HIGH"]
    return None


def _effectivity_text(groups: list[str], name: str) -> str:
    m = re.search(r"SN(\d{4})-(\d{4})(?:-(no|w)-(SB[\d-]+))?", name)
    if m and (m.group(1), m.group(2)) not in {("0001", "0172"), ("0173", "0500")}:
        txt = f"SN {m.group(1)}-{m.group(2)}"
        if m.group(3):
            txt += (" without " if m.group(3) == "no" else " with ") + m.group(4)
        return txt
    return "; ".join(SERIAL_GROUP_TEXT[g] for g in groups)


def _date(name: str) -> str | None:
    m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    return m.group(1) if m else None


def classify(path: str, name: str) -> DocMeta:
    """path is the folder path inside the library, e.g.
    '01_FAA_Approved/AFM_75FMA (SN 0173-0500, and 0001-0172 w SB750-71-10)/02_Temporary_Changes'."""
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    top = path.split("/", 1)[0] if path else ""

    # ---------- FAA MMEL (any folder): master list, never an operator MEL ----------
    if re.search(r"(?<![A-Z])MMEL(?![A-Z])", name.upper().replace("_", " ").replace("-", " ")):
        rev = _rev(stem) or _mmel_rev(stem)
        return DocMeta(family="MMEL CE-750", doc_kind="mmel",
                       title="FAA Master Minimum Equipment List (MMEL) CE-750 - master list, not an operator MEL",
                       authority=1, authority_label="FAA Approved (MMEL: not dispatch authority by itself)",
                       revision=rev, rev_date=_date(name), effectivity="All CE-750 serials (check item provisos)",
                       serial_groups=ALL_GROUPS, access="all")

    # ---------- FAA-approved AFM 75FMA ----------
    if top.startswith("01_FAA_Approved") and "75FMA" in path:
        groups = _groups_from_name(name) or AFM_75FMA_GROUPS
        eff = _effectivity_text(groups, name)
        base = dict(family="AFM 75FMA", authority=1, authority_label=AUTHORITY[1],
                    serial_groups=groups, effectivity=eff, rev_date=_date(name))

        m = re.match(r"AFM_75FMA_TC-(R\d{2}-\d{2})_Sec(\d)_p([\d-]+)_(.+)", stem)
        if m:
            tc = f"TC-{m.group(1)}"
            topic = m.group(4).split("_SN")[0].replace("-", " ")
            return DocMeta(doc_kind="tc", title=f"AFM 75FMA {tc} (Sec {m.group(2)}, p {m.group(3)}): {topic}",
                           revision=tc, tc_number=tc, tc_page=m.group(3), **base)

        m = re.match(r"AFM_75FMA_S(\d{2})-R(\d{2})_(.+)", stem)
        if m:
            s, r, topic = int(m.group(1)), m.group(2), m.group(3).replace("-", " ").replace("_", " ")
            return DocMeta(doc_kind="supplement", title=f"AFM 75FMA Supplement {s}: {topic}",
                           revision=f"S{s} Rev {r}", **base)

        m = re.match(r"AFM_75FMA-(\d{2})_Sec(\d)_(.+)", stem)
        if m:
            sec = ["", "I", "II", "III", "IV", "V", "VI", "VII"][int(m.group(2))]
            topic = m.group(3).split("_")[0].replace("-", " ")
            return DocMeta(doc_kind="section", title=f"AFM 75FMA Section {sec}: {topic}",
                           revision=f"Rev {m.group(1)}", **base)

        m = re.match(r"AFM_75FMA-(\d{2})_00_(.+)", stem)
        if m:
            topic = m.group(2).split("_")[0].replace("-", " ")
            return DocMeta(doc_kind="front_matter", title=f"AFM 75FMA {topic}",
                           revision=f"Rev {m.group(1)}", **base)

        return DocMeta(doc_kind="section", title=f"AFM 75FMA {stem}", revision=None, **base)

    # ---------- Other FAA-approved docs (future: low-serial AFM, MEL) ----------
    if top.startswith("01_FAA_Approved"):
        groups = _groups_from_name(name) or ALL_GROUPS
        kind = "mel" if re.search(r"(?<!M)MEL", name.upper()) else "manual"
        return DocMeta(family=stem.split("_")[0], doc_kind=kind, title=stem.replace("_", " "),
                       authority=1, authority_label=AUTHORITY[1], revision=_rev(stem),
                       rev_date=_date(name), effectivity=_effectivity_text(groups, name),
                       serial_groups=groups)

    # ---------- Manufacturer reference ----------
    if top.startswith("02_Manufacturer"):
        if name.startswith("OM_75OM"):
            groups = ["LOW", "LOW_SB"]
            m = re.match(r"OM_75OM-(\d{2})", stem)
            return DocMeta(family="OM 75OM", doc_kind="manual",
                           title="Cessna Operating Manual 75OM (SN 0001-0172)",
                           authority=2, authority_label=AUTHORITY[2],
                           revision=f"Rev {m.group(1)}" if m else None, rev_date=_date(name),
                           effectivity="SN 0001-0172", serial_groups=groups)
        groups = _groups_from_name(name) or ALL_GROUPS
        return DocMeta(family="Manufacturer", doc_kind="reference", title=_pretty(stem),
                       authority=2, authority_label=AUTHORITY[2], revision=_rev(stem),
                       rev_date=_date(name), effectivity=_effectivity_text(groups, name),
                       serial_groups=groups)

    # ---------- Company ----------
    if top.startswith("04_Company"):
        return DocMeta(family="Merci Jets", doc_kind="company", title=_pretty(stem),
                       authority=3, authority_label=AUTHORITY[3], revision=_rev(stem),
                       rev_date=_date(name), effectivity="All Merci Jets aircraft",
                       serial_groups=ALL_GROUPS)

    # ---------- Maintenance ----------
    if top.startswith("05_Maintenance"):
        groups = _groups_from_name(name) or ALL_GROUPS
        return DocMeta(family="Maintenance", doc_kind="reference", title=_pretty(stem),
                       authority=2, authority_label=AUTHORITY[2], revision=_rev(stem),
                       rev_date=_date(name), effectivity=_effectivity_text(groups, name),
                       serial_groups=groups, access="maintenance")

    # ---------- Training / study (and anything unknown) ----------
    groups = _groups_from_name(name) or ALL_GROUPS
    return DocMeta(family="Training", doc_kind="training", title=_pretty(stem),
                   authority=4, authority_label=AUTHORITY[4], revision=_rev(stem),
                   rev_date=_date(name), effectivity=_effectivity_text(groups, name),
                   serial_groups=groups)


def _mmel_rev(stem: str) -> str | None:
    m = re.search(r"R(\d{1,2})(?!\d)", stem)
    return f"Rev {int(m.group(1))}" if m else None


def _rev(stem: str) -> str | None:
    m = re.search(r"Rev[\s_-]?(\d+(?:\.\d+)?)", stem, flags=re.I)
    if m:
        return f"Rev {m.group(1)}"
    m = re.search(r"_(\d{2}-\d{2}|R\d+(?:\.\d+)?)_", stem)
    return m.group(1) if m else None


def _pretty(stem: str) -> str:
    s = re.sub(r"_(\d{4}-\d{2}-\d{2})$", "", stem)
    return s.replace("_", " ").replace("-", " ").strip()
