// Minimal MCP server (Streamable HTTP, JSON responses) so Claude itself can query Jeeves.
// Tools: ask_jeeves (full cited answer) and search_library (raw cited passages).
import type { Env } from "./types";
import { ask, citeLabel, pageLink } from "./core";
import { retrieve } from "./retrieve";

const TOOLS = [
  {
    name: "ask_jeeves",
    description: "Ask the Merci Jets Citation X document library (AFM incl. all live Temporary Changes and Supplements, Operating Manual, company manuals, training material). Returns a cited answer with page references. Include a tail number or serial number when it matters; serial-group differences are always shown.",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "search_library",
    description: "Return the raw passages from the Citation X library that best match a query, each with document, revision, page and effectivity. Use when you need the source text itself.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
];

export async function handleMcp(env: Env, req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("Method not allowed", { status: 405 });
  const msg: any = await req.json();
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "jeeves", version: "1.0.0" } });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      try {
        if (name === "ask_jeeves") {
          const r = await ask(env, { question: String(args.question), channel: "mcp" });
          const refs = await Promise.all(r.sources.map(async (s) => `${citeLabel(s)}: ${await pageLink(env, s)}`));
          return reply({ content: [{ type: "text", text: `${r.text}\n\nSources:\n${refs.join("\n")}` }] });
        }
        if (name === "search_library") {
          const src = await retrieve(env, String(args.query), { access: ["all", "pilots", "maintenance"], k: Math.min(Number(args.limit ?? 6), 12) });
          const text = (await Promise.all(src.map(async (s) =>
            `${citeLabel(s)} | ${s.authorityLabel} | applies to ${s.effectivity}${s.supersededBy ? ` | SUPERSEDED BY ${s.supersededBy.join(", ")}` : ""}${s.replaces ? ` | replaces AFM p ${s.replaces}` : ""}\n${await pageLink(env, s)}\n${s.text}`))).join("\n\n---\n\n");
          return reply({ content: [{ type: "text", text: text || "No matches." }] });
        }
        return error(-32602, `Unknown tool ${name}`);
      } catch (e: any) {
        return reply({ content: [{ type: "text", text: `Jeeves error: ${e.message}` }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}
