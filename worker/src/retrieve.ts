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

// Pilot wording -> manual wording. Added to the search (never shown to the pilot).
const SYNONYMS: [RegExp, string][] = [
  [/\b(service )?ceiling\b|\bmax(imum)? alt(itude)?\b|\bhow high\b/i, "maximum operating altitude enroute operational limits"],
  [/\bmtow\b/i, "maximum takeoff weight"],
  [/\bmlw\b/i, "maximum landing weight"],
  [/\bmzfw\b/i, "maximum zero fuel weight"],
  [/\bramp weight\b/i, "maximum design ramp weight"],
  [/\bvmo\b|\bmmo\b|\bredline\b|\bbarber ?pole\b/i, "maximum operating speed VMO MMO speed limits"],
  [/\bcrosswind\b|\bx-?wind\b/i, "maximum demonstrated crosswind component"],
  [/\btailwind\b/i, "maximum tailwind component takeoff landing"],
  [/\bitt\b|\binterstage\b/i, "engine ITT limits interstage turbine temperature"],
  [/\bfuel (capacity|load)\b|\bhow much fuel\b/i, "usable fuel capacity fuel limits"],
  [/\bimbalance\b|\blateral\b/i, "fuel imbalance crossfeed limits"],
  [/\bcold soak\b|\bmin(imum)? temp/i, "ambient temperature limits"],
  [/\bapu\b/i, "auxiliary power unit APU limits"],
  [/\bicing\b|\banti-?ice\b/i, "anti-ice systems icing conditions limitations"],
  [/\bgear speed\b|\bvle\b|\bvlo\b/i, "landing gear operating extended speed VLO VLE"],
  [/\bflap speed\b|\bvfe\b/i, "flap extended speed VFE"],
];

function expand(question: string): string {
  const extra = SYNONYMS.filter(([re]) => re.test(question)).map(([, words]) => words);
  return extra.length ? `${question} ${extra.join(" ")}` : question;
}

const AUTHORITATIVE_SLOTS = 5;   // FAA-approved / manufacturer passages guaranteed a place
const CANDIDATES = 60;

export async function retrieve(env: Env, question: string, opts: { access: string[]; k?: number }): Promise<Source[]> {
  const k = opts.k ?? 9;
  const searchText = expand(question);

  // 1) semantic
  const emb = (await env.AI.run(EMBED_MODEL, { text: [searchText] })) as { data: number[][] };
  const vec = await env.VEC.query(emb.data[0], { topK: 40, returnMetadata: "indexed" });
  const semantic = vec.matches.map((m) => m.id);

  // 2) keyword
  let keyword: string[] = [];
  const fq = ftsQuery(searchText);
  if (fq) {
    const r = await env.DB.prepare(
      `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
       WHERE chunks_fts MATCH ?1 ORDER BY rank LIMIT 40`).bind(fq).all<{ id: string }>();
    keyword = r.results.map((x) => x.id);
  }

  // 3) reciprocal rank fusion
  const score = new Map<string, number>();
  const add = (ids: string[], w: number) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + w / (60 + i)));
  add(semantic, 1.0);
  add(keyword, 1.0);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (!ranked.length) return [];

  const rows = await loadChunks(env, ranked.slice(0, CANDIDATES));
  const allowed = rows.filter((r) => opts.access.includes(r.access));

  // Authority-balanced pick: study aids can't crowd the AFM out. Keep fused-rank order.
  const auth = allowed.filter((r) => r.authority <= 2).slice(0, AUTHORITATIVE_SLOTS);
  const rest = allowed.filter((r) => !auth.includes(r)).slice(0, Math.max(0, k - auth.length));
  const chosen = new Set([...auth, ...rest]);
  const top = allowed.filter((r) => chosen.has(r));

  // Serial-group gap fill: if no authoritative passage covers the low serials (0001-0172),
  // search the documents that do (e.g. Operating Manual 75OM) so that group is never left blank.
  if (fq && !top.some((s) => s.authority <= 2 && s.serialGroups.includes("LOW"))) {
    const low = await env.DB.prepare(
      `SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid JOIN documents d ON d.drive_id = c.drive_id
       WHERE chunks_fts MATCH ?1 AND d.active = 1 AND d.authority <= 2 AND d.serial_groups LIKE '%"LOW"%'
       ORDER BY rank LIMIT 2`).bind(fq).all<{ id: string }>();
    for (const c of await loadChunks(env, low.results.map((x) => x.id)))
      if (opts.access.includes(c.access) && !top.some((t) => t.chunkId === c.chunkId)) top.push(c);
  }

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

  // 5) Chief Pilot notes that match the question (verified corrections / clarifications).
  const nq = ftsQuery(question);
  if (nq) {
    const notes = await env.DB.prepare(
      `SELECT n.id, n.title, n.text, n.applies_to, n.author FROM notes_fts f JOIN notes n ON n.id = f.rowid
       WHERE notes_fts MATCH ?1 AND n.active = 1 ORDER BY rank LIMIT 3`).bind(nq).all<any>().catch(() => ({ results: [] as any[] }));
    for (const x of notes.results) top.push({
      n: 0, chunkId: `note:${x.id}`, pageId: `note:${x.id}`, driveId: `note:${x.id}`, title: `Chief Pilot note: ${x.title}`,
      revision: null, authority: 3, authorityLabel: `Merci Jets Chief Pilot note (${x.author})`, effectivity: x.applies_to,
      serialGroups: [], pageLabel: null, pageIndex: 0, hasFigure: false, imageKey: null, docKind: "note", text: x.text,
      access: "all", family: "Notes",
    } as Row);
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
