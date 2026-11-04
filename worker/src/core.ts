// Shared pieces: the ask() pipeline, tail lookup, signed page links, logging.
import type { Env, Aircraft } from "./types";
import { retrieve, type Source } from "./retrieve";
import { answer } from "./answer";

export const FOOTER = "Reference aid only. Verify against the current AFM/QRH and company manuals.";

export interface AskResult { text: string; sources: Source[]; aircraft: Aircraft | null; questionId: number | null }

export async function ask(env: Env, q: { question: string; channel: string; user?: string; access?: string[]; contextText?: string; history?: string[] }): Promise<AskResult> {
  const aircraft = await findAircraft(env, `${q.question} ${q.contextText ?? ""}`);
  const sources = await retrieve(env, q.question, { access: q.access ?? ["all", "pilots"] });
  const a = await answer(env, q.question, sources, aircraft, q.history ?? []);
  const shown = a.used.length ? a.used : sources.slice(0, 3);
  const questionId = await logQuestion(env, q.channel, q.user, aircraft?.tail ?? null, q.question, a.text, shown.map((s) => s.pageId));
  return { text: a.text, sources: shown, aircraft, questionId };
}

export async function findAircraft(env: Env, text: string): Promise<Aircraft | null> {
  const tails = [...new Set((text.toUpperCase().match(/\bN\d{1,5}[A-Z]{0,2}\b/g) ?? []))];
  for (const t of tails) {
    const row = await env.DB.prepare("SELECT * FROM aircraft WHERE tail = ?").bind(t).first<Aircraft>();
    if (row) return row;
  }
  const sn = text.match(/\b(?:SN|S\/N|SERIAL)\s*(?:750-)?0*(\d{1,3})\b/i);
  if (sn) {
    const n = Number(sn[1]);
    const row = await env.DB.prepare("SELECT * FROM aircraft WHERE CAST(substr(serial, 5) AS INTEGER) = ?").bind(n).first<Aircraft>();
    if (row) return row;
    return { tail: `SN ${String(n).padStart(4, "0")}`, serial: `750-${String(n).padStart(4, "0")}`, serial_group: n >= 173 ? "HIGH" : "LOW?", notes: n < 173 ? "SB750-71-10 status unknown" : null };
  }
  return null;
}

async function logQuestion(env: Env, channel: string, user: string | undefined, tail: string | null, question: string, text: string, cited: string[]): Promise<number | null> {
  try {
    const r = await env.DB.prepare(
      "INSERT INTO questions (asked_at, channel, user_ref, tail, question, answer, cited) VALUES (?,?,?,?,?,?,?) RETURNING id")
      .bind(new Date().toISOString(), channel, user ?? null, tail, question, text, JSON.stringify(cited)).first<{ id: number }>();
    return r?.id ?? null;
  } catch { return null; }
}

export async function recordFeedback(env: Env, id: number, value: 1 | -1) {
  await env.DB.prepare("UPDATE questions SET feedback = ? WHERE id = ?").bind(value, id).run();
}

// ---- signed "View page" links (valid 7 days) ----
async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function pageLink(env: Env, s: Source): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const sig = await hmac(env.LINK_SECRET, `${s.pageId}.${exp}`);
  return `${env.PUBLIC_BASE_URL}/page/${encodeURIComponent(s.pageId)}?exp=${exp}&sig=${sig}`;
}

export async function verifyPageLink(env: Env, pageId: string, exp: string, sig: string): Promise<boolean> {
  if (!exp || Number(exp) < Date.now() / 1000) return false;
  return (await hmac(env.LINK_SECRET, `${pageId}.${exp}`)) === sig;
}

export function citeLabel(s: Source): string {
  return `[${s.n}] ${s.title}${s.revision && !s.title.includes(s.revision) ? ` ${s.revision}` : ""}, p ${s.pageLabel ?? s.pageIndex + 1}`;
}
