// Slack: /jeeves slash command (private answer), @Jeeves mentions (threaded,
// visible to the channel), DMs, and the feedback buttons.
import type { Env } from "./types";
import { ask, citeLabel, pageLink, recordFeedback, FOOTER, type AskResult } from "./core";

export async function verifySlack(env: Env, req: Request, body: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const hex = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.length === sig.length && crypto.subtle.timingSafeEqual(new TextEncoder().encode(hex), new TextEncoder().encode(sig));
}

async function slackApi(env: Env, method: string, payload: unknown) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return r.json<any>();
}

async function blocksFor(env: Env, question: string, res: AskResult): Promise<any[]> {
  const blocks: any[] = [];
  if (res.aircraft) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `:airplane: ${res.aircraft.tail} · ${res.aircraft.serial}` }] });
  // Slack section text max is 3000 chars
  for (let i = 0; i < res.text.length; i += 2900) blocks.push({ type: "section", text: { type: "mrkdwn", text: res.text.slice(i, i + 2900) } });
  if (res.sources.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: res.sources.map(citeLabel).join("\n").slice(0, 2900) }] });
    const buttons = await Promise.all(res.sources.slice(0, 5).map(async (s) => ({
      type: "button", text: { type: "plain_text", text: `View [${s.n}] p ${s.pageLabel ?? s.pageIndex + 1}`.slice(0, 75) }, url: await pageLink(env, s),
    })));
    blocks.push({ type: "actions", elements: buttons });
  }
  if (res.questionId) blocks.push({ type: "actions", elements: [
    { type: "button", text: { type: "plain_text", text: ":thumbsup: Helpful" }, action_id: "fb_up", value: String(res.questionId) },
    { type: "button", text: { type: "plain_text", text: ":thumbsdown: Wrong / not helpful" }, action_id: "fb_down", value: String(res.questionId) },
  ] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${FOOTER}_` }] });
  return blocks;
}

function friendlyError(e: unknown) {
  console.error(e);
  return ":warning: Jeeves hit an error answering that. Please try again; if it keeps happening, use the AFM directly and let ops know.";
}

// ---- /jeeves slash command ----
export async function handleCommand(env: Env, ctx: ExecutionContext, body: string): Promise<Response> {
  const p = new URLSearchParams(body);
  const question = (p.get("text") ?? "").trim();
  if (!question) return Response.json({ response_type: "ephemeral", text: "Ask me something, e.g. `/jeeves max crosswind for takeoff`. Add a tail number (N702FL) to see the right serial group first." });
  const responseUrl = p.get("response_url")!;
  ctx.waitUntil((async () => {
    try {
      const res = await ask(env, { question, channel: "slack", user: p.get("user_id") ?? undefined, contextText: p.get("channel_name") ?? "" });
      await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text: res.text.slice(0, 300), blocks: await blocksFor(env, question, res) }) });
    } catch (e) {
      await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text: friendlyError(e) }) });
    }
  })());
  return Response.json({ response_type: "ephemeral", text: `:mag: Looking that up: _${question.slice(0, 200)}_` });
}

// ---- events: @Jeeves mentions and DMs ----
export async function handleEvent(env: Env, ctx: ExecutionContext, body: string, req: Request): Promise<Response> {
  const payload = JSON.parse(body);
  if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });
  if (req.headers.get("x-slack-retry-num")) return new Response("ok"); // already handling the first delivery
  const ev = payload.event;
  if (!ev || ev.bot_id || ev.subtype) return new Response("ok");
  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDm) return new Response("ok");

  const question = String(ev.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const thread_ts = ev.thread_ts ?? ev.ts;
  ctx.waitUntil((async () => {
    const placeholder = await slackApi(env, "chat.postMessage", { channel: ev.channel, thread_ts, text: ":mag: Looking that up…" });
    try {
      // Channel name (e.g. trip-0412-n702fl) helps pick the tail.
      const info = isMention ? await slackApi(env, "conversations.info", { channel: ev.channel }) : null;
      const history = ev.thread_ts ? await threadHistory(env, ev.channel, ev.thread_ts) : [];
      const res = await ask(env, { question, channel: "slack", user: ev.user, contextText: `${info?.channel?.name ?? ""} ${history.join(" ")}`, history });
      await slackApi(env, "chat.update", { channel: ev.channel, ts: placeholder.ts, text: res.text.slice(0, 300), blocks: await blocksFor(env, question, res) });
    } catch (e) {
      await slackApi(env, "chat.update", { channel: ev.channel, ts: placeholder.ts, text: friendlyError(e) });
    }
  })());
  return new Response("ok");
}

async function threadHistory(env: Env, channel: string, ts: string): Promise<string[]> {
  const r = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}&limit=10`, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  const j: any = await r.json();
  return (j.messages ?? []).slice(0, -1).map((m: any) => `${m.bot_id ? "Jeeves" : "Pilot"}: ${String(m.text ?? "").slice(0, 500)}`);
}

// ---- buttons ----
export async function handleInteraction(env: Env, body: string): Promise<Response> {
  const payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");
  const action = payload.actions?.[0];
  if (action?.action_id === "fb_up" || action?.action_id === "fb_down") {
    await recordFeedback(env, Number(action.value), action.action_id === "fb_up" ? 1 : -1);
    if (payload.response_url) await fetch(payload.response_url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: action.action_id === "fb_up" ? "Thanks, noted." : "Thanks. Flagged for the Chief Pilot to review." }) });
  }
  return new Response("");
}
