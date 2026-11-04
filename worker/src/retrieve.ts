// Hybrid retrieval: Vectorize (meaning) + D1 FTS5 (exact terms), fused, then
// expanded with the Temporary Changes that replace any AFM page that was hit.
import type { Env } from "./types";

export interface Source {
  n: number;                 // citation number shown to the model and the user
  chunkId: string;
  pageId: string;
  driveId: string;
  title: string;
  revision: string | null;
  authority: number;
  authorityLabel: string;
  effectivity: string;
  serialGroups: string[];
  pageLabel: string | null;
  pageIndex: number;
  hasFigure: boolean;
  imageKey: string | null;
  docKind: string;
  text: string;
  supersededBy?: string[];   // TC numbers that replace this AFM page
  replaces?: string;         // for TC sources: the AFM page they replace
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

function ftsQuery(q: string): string {
  // Keep words, CAS-style tokens and numbers; OR them so partial matches still rank.
  const terms = q.toUpperCase().match(/[A-Z0-9][A-Z0-9\-\/.]{1,}/g) ?? [];
  const stop = new Set(["THE", "AND", "FOR", "WHAT", "WITH", "IS", "ARE", "OF", "TO", "IN", "ON", "A", "AN", "DOES", "HOW", "CAN", "WE", "I", "IT", "BE", "OR", "WHEN", "MY"]);
  const kept = [...new Set(terms.filter((t) => !stop.has(t)))].slice(0, 12);
  return kept.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export async function retrieve(env: Env, question: string, opts: { access: string[]; k?: number }): Promise<Source[]> {
  const k = opts.k ?? 8;

  // 1) semantic
  const emb = (await env.AI.run(EMBED_MODEL, { text: [question] })) as { data: number[][] };
  const vec = await env.VEC.query(emb.data[0], { topK: 24, returnMetadata: "indexed" });
  const semantic = vec.matches.map((m) => m.id);

  // 2) keyword
  let keyword: string[] = [];
  const fq = ftsQuery(question);
  if (fq) {
    const r = await env.DB.prepare(
      `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
       WHERE chunks_fts MATCH ?1 ORDER BY rank LIMIT 24`).bind(fq).all<{ id: string }>();
    keyword = r.results.map((x) => x.id);
  }

  // 3) reciprocal rank fusion
  const score = new Map<string, number>();
  const add = (ids: string[], w: number) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + w / (60 + i)));
  add(semantic, 1.0);
  add(keyword, 1.0);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (!ranked.length) return [];

  const rows = await loadChunks(env, ranked.slice(0, 30));
  const allowed = rows.filter((r) => opts.access.includes(r.access));
  const top = allowed.slice(0, k);

  // 4) TC overlay: any AFM page hit that a live TC replaces pulls that TC in.
  const labels = [...new Set(top.filter((s) => s.family === "AFM 75FMA" && s.pageLabel).map((s) => s.pageLabel!))];
  if (labels.length) {
    const tcs = await env.DB.prepare(
      `SELECT tc_number, afm_page, drive_id FROM tc_overrides WHERE afm_page IN (${labels.map(() => "?").join(",")})`)
      .bind(...labels).all<{ tc_number: string; afm_page: string; drive_id: string }>();
    for (const t of tcs.results) {
      for (const s of top) if (s.pageLabel === t.afm_page && s.family === "AFM 75FMA" && s.docKind !== "tc")
        (s.supersededBy ??= []).push(t.tc_number);
      if (!top.some((s) => s.driveId === t.drive_id)) {
        const tcRows = await env.DB.prepare(`SELECT id FROM chunks WHERE drive_id = ? ORDER BY id`).bind(t.drive_id).all<{ id: string }>();
        const tcChunks = await loadChunks(env, tcRows.results.map((r) => r.id).slice(0, 4));
        for (const c of tcChunks) top.push({ ...c, replaces: t.afm_page });
      }
    }
  }

  return top.map((s, i) => ({ ...s, n: i + 1 }));
}

type Row = Source & { access: string; family: string };

async function loadChunks(env: Env, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const r = await env.DB.prepare(
    `SELECT c.id chunk_id, c.text, c.page_id, c.drive_id, p.page_label, p.page_index, p.has_figure, p.image_key,
            d.title, d.revision, d.authority, d.authority_label, d.effectivity, d.serial_groups, d.doc_kind, d.access, d.family
     FROM chunks c JOIN pages p ON p.id = c.page_id JOIN documents d ON d.drive_id = c.drive_id
     WHERE d.active = 1 AND c.id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<any>();
  const byId = new Map(r.results.map((x) => [x.chunk_id, x]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const x = byId.get(id);
    return {
      n: 0, chunkId: x.chunk_id, pageId: x.page_id, driveId: x.drive_id, title: x.title, revision: x.revision,
      authority: x.authority, authorityLabel: x.authority_label, effectivity: x.effectivity,
      serialGroups: JSON.parse(x.serial_groups), pageLabel: x.page_label, pageIndex: x.page_index,
      hasFigure: !!x.has_figure, imageKey: x.image_key, docKind: x.doc_kind, text: x.text,
      access: x.access, family: x.family,
    };
  });
}
