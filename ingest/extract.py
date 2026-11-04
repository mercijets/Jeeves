"""Turn one PDF into pages and chunks.

Each page keeps its printed page number (e.g. 2-210-1), AFM configuration code,
whether it is an inline Temporary Change, and a rendered PNG for 'View page' and
chart reading. Chunks are page-sized so every answer can cite an exact page.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import pymupdf

AFM_PAGE_RE = re.compile(r"(?<![\d-])(\d{1,2}-\d{3}-\d{1,3}[A-Z]?)(?![\d-])")
SUPP_PAGE_RE = re.compile(r"\b(S\d{1,2}-\d{1,3})\b")
CONFIG_RE = re.compile(r"^\s*(A[A-Z])\s*$", re.M)
TC_INLINE_RE = re.compile(r"75FMA\s+TC-(R\d{2}-\d{2})")
TC_HEADER = "TEMPORARY FAA APPROVED AIRPLANE"
DOT_LEADER_RE = re.compile(r"(?:\s?\.){4,}\s?")

MAX_CHUNK_CHARS = 2400
RENDER_DPI = 110          # crisp enough to read charts, ~150-300 KB per page
FIGURE_DPI = 200          # pages that are mostly charts get a sharper render


@dataclass
class Page:
    index: int
    label: str | None
    config_code: str | None
    is_tc_inline: bool
    tc_number: str | None
    has_figure: bool
    text: str
    png: bytes = b""
    chunks: list[tuple[str | None, str]] = field(default_factory=list)  # (heading, text)


BOILERPLATE = re.compile(
    r"^\s*(MODEL 750|MODEL|750|FAA APPROVED|U\.S\.|Configuration|SECTION [IVX]+ - [A-Z /&-]+|"
    r"75FMA-\d{2}|75FMA--null|A[A-Z]|\(Continued Next Page\))\s*$", re.M)


def _clean(text: str) -> str:
    text = BOILERPLATE.sub("", text)
    text = DOT_LEADER_RE.sub(" .... ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _page_label(text: str, doc_kind: str) -> str | None:
    tail = text[-400:]  # page numbers live in the footer
    if doc_kind == "supplement":
        m = SUPP_PAGE_RE.findall(tail)
        if m:
            return m[-1]
    found = AFM_PAGE_RE.findall(tail) or AFM_PAGE_RE.findall(text[:300])
    return found[-1] if found else None


def _heading(text: str) -> str | None:
    """First all-caps line that looks like a heading (skips the running header)."""
    skip = {"MODEL 750", "FAA APPROVED", "U.S.", "CONFIGURATION", "ADVISORY"}
    for line in text.splitlines()[:25]:
        s = line.strip()
        if len(s) < 4 or s.upper() in skip or s.startswith("SECTION "):
            continue
        letters = [c for c in s if c.isalpha()]
        if letters and sum(c.isupper() for c in letters) / len(letters) > 0.85 and len(s) < 90:
            return s
    return None


def _split(text: str) -> list[str]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [text]
    parts, cur = [], ""
    for para in re.split(r"\n(?=[A-Z][A-Z /&()-]{3,}\n)|\n\n", text):
        if len(cur) + len(para) > MAX_CHUNK_CHARS and cur:
            parts.append(cur.strip())
            cur = ""
        cur += para + "\n"
    if cur.strip():
        parts.append(cur.strip())
    # hard-split anything still too long
    out = []
    for p in parts:
        while len(p) > MAX_CHUNK_CHARS * 1.5:
            out.append(p[:MAX_CHUNK_CHARS])
            p = p[MAX_CHUNK_CHARS - 200:]
        out.append(p)
    return out


def extract(pdf_bytes: bytes, doc_kind: str, render: bool = True) -> list[Page]:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    pages: list[Page] = []
    for i, p in enumerate(doc):
        raw = p.get_text("text")
        text = _clean(raw)
        tc_m = TC_INLINE_RE.search(raw)
        is_tc_inline = doc_kind != "tc" and TC_HEADER in raw and tc_m is not None
        cfg = CONFIG_RE.findall(raw[-300:])
        # A page is a "figure" page if it has little text but lots of drawing/images
        drawing_count = len(p.get_drawings()) if len(text) < 1500 else 0
        has_figure = (len(text) < 1200 and (drawing_count > 150 or len(p.get_images()) > 0)) or "Figure" in text[:200] and len(text) < 900
        page = Page(
            index=i,
            label=_page_label(raw, doc_kind),
            config_code=cfg[-1] if cfg else None,
            is_tc_inline=is_tc_inline,
            tc_number=f"TC-{tc_m.group(1)}" if tc_m else None,
            has_figure=has_figure,
            text=text,
        )
        if render:
            dpi = FIGURE_DPI if has_figure else RENDER_DPI
            page.png = p.get_pixmap(dpi=dpi).tobytes("png")
        if text and not is_tc_inline:
            heading = _heading(raw)
            page.chunks = [(heading, c) for c in _split(text)]
        elif has_figure and not text:
            page.chunks = [(None, "[Chart or figure page with no extractable text]")]
        pages.append(page)
    return pages
