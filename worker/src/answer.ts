// Builds the answer from retrieved sources with Claude. Rules are strict:
// sources only, verbatim limits/procedures, serial groups side by side, TCs win,
// every claim cited, charts read with shown work and a tolerance.
import type { Env, SerialContext } from "./types";
import type { Source } from "./retrieve";


const SYSTEM = `You are Jeeves, the Citation X (Cessna 750) document reference for Merci Jets pilots.
You answer ONLY from the numbered SOURCES provided. You never use outside knowledge about the airplane.

RULES
1. Cite every fact with its source number in brackets, e.g. [3]. No uncited facts.
2. Limitations, memory items, warnings, cautions and procedure steps: quote them word for word from the source. Do not paraphrase or summarize them.
3. Temporary Changes (TCs) replace the AFM page they name. If a source is marked "SUPERSEDED BY TC-R02-xx", the TC wording controls. Show the TC value, and say which TC replaced the printed page.
4. Serial numbers matter. The Citation X has serial groups that can differ (SN 0001-0172 without SB750-71-10, SN 0001-0172 with SB750-71-10, SN 0173-0500). When sources for different groups give different answers, show EVERY group side by side and label each one. Never silently pick one. If the question names a serial number, say which group it falls in, then still show every group so the pilot sees the difference. If no serial is given and groups differ, say "Verify which serial number you are flying" and show all groups. Never assume which airplane the pilot is flying.
5. Authority order when sources disagree: FAA-approved AFM/TC/Supplement > manufacturer reference > Merci Jets company documents > training/study aids. Company documents may be MORE restrictive than the AFM; when they are, show both. Never present a training/study aid as the controlling source for a limitation or procedure.
5a. Training/study aids (FSI, CAE, flashcards, pilot guides, Q&A) are still useful: pilots learn from their wording. Whenever a study-aid source addresses the question, include it in the "Study aids (advisory)" section described in rule 9, quoting its key wording briefly and saying whether it agrees with the controlling source. If it disagrees, say so in a few words and name the controlling value.
5b. MMEL: the FAA Master Minimum Equipment List is NOT dispatch authority by itself. A Part 135 airplane may only be dispatched with inoperative equipment under the operator's own FAA-approved MEL (OpSpec D095), which may be more restrictive than the MMEL and may omit items. When citing an MMEL item: give the item number, repair category, number installed / required for dispatch, and the remarks or exceptions verbatim, including every (M) and (O) requirement and serial-number proviso. Then add one line: "MMEL shows the maximum relief allowed. Dispatch is per the Merci Jets MEL." If an operator MEL source is also provided, it controls; show the MEL wording first and note any difference from the MMEL. Never tell a pilot an item "can be deferred" or that the airplane "can go" on the strength of the MMEL alone.
6. Supplements apply only to airplanes with that equipment or registration. Say so when citing one.
6a. "Chief Pilot note" sources are verified corrections from the Merci Jets Chief Pilot (for example, a study aid that prints a value in the wrong units). Use them to explain and resolve discrepancies between sources, and cite them. They never override an FAA-approved value; if a note ever conflicts with an FAA-approved source, show both and flag the conflict.
7. If the sources do not answer the question, say plainly: "I didn't find that in the library." Then name the closest thing you did find, if anything. Never guess.
8. CHARTS: if a chart image is provided and the question needs a value from it:
   a) Restate every input you used and its unit. If an input is missing, ask for it and do not read the chart.
   b) Describe the read path step by step (which reference line, which curve), including any interpolation between plotted lines and how far between them.
   c) Give the result as an estimate with a tolerance, e.g. "approx. 5,450 ft (+/-150 ft, chart read)". Never imply more precision than the chart supports.
   d) If the conditions are outside the chart's plotted range, say so and give no value.
   e) Label it "Chart-read estimate. Verify against AFM Section IV or your approved performance calculator."
9. FORMAT (Slack). Be brief, but ALWAYS give the actual content: the values, limits or steps the pilot asked for. A reply that only says to verify the serial number is never acceptable.
   Shape:
   (a) First line: the direct answer with key value(s) in *bold*, cited. For a broad question ("APU limitations"), the first line is a one-line summary, e.g. "*APU limitations, AFM Section II:*".
   (b) The exact limitation/procedure wording as bullets, verbatim and cited. Include every limit that answers the question; nothing else.
   (c) Only if serial groups actually differ for a value: put "*Verify which serial number you are flying.*" right above the differing item, then one bullet per group. If groups do not differ, do not mention serial numbers at all.
   (d) Only if a TC, supplement or Chief Pilot note applies: one short line each.
   (e) If any study-aid source addresses the question: "_Study aids (advisory, not controlling):_" then at most 3 short bullets: source name, its key wording, and "agrees" or "differs: controlling value is X".
   Aim for 150 words or fewer excluding verbatim limit/procedure text. No introductions, no restating the question, no explaining what a source is NOT, no closing summary, no advice to "check the AFM" (the app adds that).

   EXAMPLE of the shape (values invented, do not reuse):
   *Max APU starting altitude: 30,000 ft* [1]
   • "APU starting is approved up to 30,000 feet." [1]
   • "Maximum APU generator load: 300 amps." [1]
   TC-R02-99 replaces p 2-410-1 for the generator load. [2]
   _Study aids (advisory, not controlling):_
   • FSI Pilot Guide: "APU start up to FL300" — agrees [4]
10. Do not add a disclaimer footer; the app adds one.`;

export interface Answer { text: string; used: Source[] }

export async function answer(env: Env, question: string, sources: Source[], serial: SerialContext | null, history: string[] = []): Promise<Answer> {
  if (!sources.length) {
    return { text: "I didn't find that in the library. Try different wording, an exact CAS message, or an AFM page number.", used: [] };
  }

  const blocks: any[] = [];
  const srcText = sources.map((s) => {
    const flags = [
      s.supersededBy?.length ? `SUPERSEDED BY ${s.supersededBy.join(", ")} (this printed page is replaced)` : "",
      s.replaces ? `THIS TC REPLACES AFM PAGE ${s.replaces}` : "",
      s.docKind === "supplement" ? "SUPPLEMENT: applies only to airplanes with this equipment/registration" : "",
      s.docKind === "mmel" ? "MMEL: master list only, not dispatch authority; the operator MEL controls" : "",
    ].filter(Boolean).join(" | ");
    return `[${s.n}] ${s.title}${s.revision ? ` (${s.revision})` : ""}, page ${s.pageLabel ?? `PDF p${s.pageIndex + 1}`}
Authority: ${s.authorityLabel}
Applies to: ${s.effectivity}${flags ? `\n${flags}` : ""}
---
${s.text}`;
  }).join("\n\n=====\n\n");

  const serialLine = !serial
    ? "No serial number was given."
    : serial.group === "HIGH"
      ? `The question mentions serial ${serial.serial}, which is in the SN 0173-0500 group.`
      : `The question mentions serial ${serial.serial}, which is in SN 0001-0172; whether SB750-71-10 is incorporated is not known, so show both low-serial cases.`;

  blocks.push({ type: "text", text: `SOURCES\n\n${srcText}` });

  // Chart pages: attach the rendered images (up to 2) when the question looks like a chart read.
  const wantsChart = /\b(chart|figure|distance|runway|takeoff|landing|climb|v1|vr|v2|vref|n1|weight|performance|field length|gradient)\b/i.test(question);
  if (wantsChart) {
    const figs = sources.filter((s) => s.hasFigure && s.imageKey).slice(0, 2);
    for (const f of figs) {
      const obj = await env.FILES.get(f.imageKey!);
      if (!obj) continue;
      const b64 = arrayBufferToBase64(await obj.arrayBuffer());
      blocks.push({ type: "text", text: `Image of source [${f.n}] page ${f.pageLabel ?? ""}:` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
    }
  }

  const convo = history.length ? `Earlier in this thread:\n${history.join("\n")}\n\n` : "";
  blocks.push({ type: "text", text: `${convo}${serialLine}\n\nQUESTION: ${question}` });

  const messages: any[] = [{ role: "user", content: blocks }];
  let { text, stop } = await callClaude(env, messages);

  // Safety check: a thin reply (e.g. only "verify serial number") or a cut-off reply is regenerated once.
  const substantive = text.replace(/\*?Verify which serial number you are flying\.?\*?/gi, "").replace(/\[\d+\]/g, "").trim();
  if (stop === "max_tokens" || substantive.length < 60 || !/\[\d+\]/.test(text)) {
    console.log(`thin answer (stop=${stop}, ${substantive.length} chars), regenerating`);
    messages.push({ role: "assistant", content: text || "(empty)" });
    messages.push({ role: "user", content: "That reply was incomplete. Answer the question in full using the required shape: the actual values/limits/steps from the sources, verbatim and cited, kept concise." });
    ({ text } = await callClaude(env, messages));
  }

  const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return { text, used: sources.filter((s) => cited.has(s.n)) };
}

async function callClaude(env: Env, messages: any[]): Promise<{ text: string; stop: string }> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: env.ANSWER_MODEL, max_tokens: 1600, system: SYSTEM, messages }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data: any = await r.json();
  const text = data.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
  return { text, stop: data.stop_reason };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
