import type { Env } from "./types";
import { handleCommand, handleEvent, handleInteraction, verifySlack } from "./slack";
import { handleMcp } from "./mcp";
import { ask, citeLabel, pageLink, verifyPageLink, FOOTER } from "./core";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // ---- Slack ----
    if (url.pathname.startsWith("/slack/") && req.method === "POST") {
      const body = await req.text();
      if (!(await verifySlack(env, req, body))) return new Response("bad signature", { status: 401 });
      if (url.pathname === "/slack/commands") return handleCommand(env, ctx, body);
      if (url.pathname === "/slack/events") return handleEvent(env, ctx, body, req);
      if (url.pathname === "/slack/interactions") return handleInteraction(env, body);
      return new Response("not found", { status: 404 });
    }

    // ---- signed page image ----
    if (url.pathname.startsWith("/page/")) {
      const pageId = decodeURIComponent(url.pathname.slice(6));
      if (!(await verifyPageLink(env, pageId, url.searchParams.get("exp") ?? "", url.searchParams.get("sig") ?? "")))
        return new Response("This link has expired. Ask Jeeves again for a fresh link.", { status: 403 });
      const row = await env.DB.prepare(
        `SELECT p.image_key, p.page_label, d.title, d.revision FROM pages p JOIN documents d USING(drive_id) WHERE p.id = ?`)
        .bind(pageId).first<any>();
      if (!row?.image_key) return new Response("Page not found", { status: 404 });
      if (url.searchParams.get("raw") === "1") {
        const obj = await env.FILES.get(row.image_key);
        if (!obj) return new Response("Page not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
      }
      const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.title)} p ${esc(row.page_label ?? "")}</title>
<style>body{margin:0;background:#1d1f22;color:#eee;font:14px system-ui}header{padding:10px 14px}img{display:block;max-width:100%;margin:0 auto;background:#fff}</style>
<header>${esc(row.title)}${row.revision ? " · " + esc(row.revision) : ""} · page ${esc(row.page_label ?? "")}<br><small>${esc(FOOTER)}</small></header>
<img src="${url.pathname}${url.search}&raw=1" alt="Manual page">`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // ---- token-protected API + MCP (web portal and Claude) ----
    if (url.pathname === "/api/ask" || url.pathname === "/mcp") {
      if (req.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/mcp") return handleMcp(env, req);
      const { question } = await req.json<{ question: string }>();
      const r = await ask(env, { question, channel: "web" });
      return Response.json({ answer: r.text, footer: FOOTER, serial: r.serial,
        sources: await Promise.all(r.sources.map(async (s) => ({ label: citeLabel(s), effectivity: s.effectivity, authority: s.authorityLabel, url: await pageLink(env, s) }))) });
    }

    if (url.pathname === "/health") {
      const n = await env.DB.prepare("SELECT count(*) n, max(indexed_at) last FROM documents WHERE active=1").first<any>();
      return Response.json({ ok: true, documents: n?.n, last_indexed: n?.last });
    }
    return new Response("Jeeves", { status: 200 });
  },
};
