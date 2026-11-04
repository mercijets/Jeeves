// Shared pieces: the ask() pipeline, serial-number parsing, signed page links, logging.
import type { Env, SerialContext } from "./types";
import { retrieve, type Source } from "./retrieve";
import { answer } from "./answer";

export const FOOTER = "Reference aid only. Verify against the current AFM/QRH and company manuals.";

export interface AskResult { text: string; sources: Source[]; serial: SerialContext | null; questionId: number | null }

export async function ask(env: Env, q: { question: string; channel: string; user?: string; access?: string[]; contextText?: string; history?: string[] }): Promise<AskResult> {
  const serial = parseSerial(q.question);
  const sources = await retrieve(env, q.question, { access: q.access ?? ["all", "pilots"] });
  const a = await answer(env, q.question, sources, serial, q.history ?? []);
  const shown = a.used.length ? a.used : sources.slice(0, 3);
  const questionId = await logQuestion(env, q.channel, q.user, serial?.serial ?? null, q.question, a.text, shown.map((s) => s.pageId));
  return { text: a.text, sources: shown, serial, questionId };
}

// Generic: if the pilot typed a Citation X serial, note its group using Cessna's ranges.
// Nothing about any specific aircraft is stored or looked up.
export function parseSerial(text: string): SerialContext | null {
  const m = text.match(/\b(?:SN|S\/N|SERIAL(?:\s+NUMBER)?|750-)\s*#?\s*0*(\d{1,3})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 500) return null;
  return { serial: `750-${String(n).padStart(4, "0")}`, group: n >= 173 ? "HIGH" : "LOW_OR_LOW_SB" };
}

async function logQuestion(env: Env, channel: string, user: string | undefined, serial: string | null, question: string, text: string, cited: string[]): Promise<number | null> {
  try {
    const r = await env.DB.prepare(
      "INSERT INTO questions (asked_at, channel, user_ref, serial, question, answer, cited) VALUES (?,?,?,?,?,?,?) RETURNING id")
      .bind(new Date().toISOString(), channel, user ?? null, serial, question, text, JSON.stringify(cited)).first<{ id: number }>();
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
  if (s.docKind === "note") return `[${s.n}] ${s.title}`;
  const page = s.pageLabel ?? String(s.pageIndex + 1);
  const pagePart = s.title.includes(page) ? "" : `, p ${page}`;
  return `[${s.n}] ${s.title}${s.revision && !s.title.includes(s.revision) ? ` ${s.revision}` : ""}${pagePart}`;
}
