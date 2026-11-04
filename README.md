# Jeeves

Citation X document reference for Merci Jets. Ask in Slack (`/jeeves`, `@Jeeves`, DM), from Claude (MCP), or over the API. Every answer cites document, revision and page, links to the page image, applies live Temporary Changes over the pages they replace, and shows serial-group differences side by side.

Jeeves is a reference aid. It is not referenced in, and does not replace, any Merci Jets manual.

```
Google Drive "Jeeves Library"  ──hourly (GitHub Actions)──▶  ingest/  ──▶  Cloudflare R2 (PDFs, page images)
   (humans manage revisions)                                             D1 (documents, pages, text, TCs, log)
                                                                         Vectorize (embeddings)
                                                                              │
                         Slack /jeeves, @Jeeves, DM ◀── worker/ (always on) ──┤──▶ Claude API (answers)
                         Claude via MCP, /api/ask   ◀──────────────────────────┘
```

| Path | What |
|---|---|
| `ingest/library.py` | Folder/file-name rules → doc type, authority, revision, effectivity, TC page |
| `ingest/extract.py` | PDF → pages (printed page no., config code, inline-TC detection, PNG) → chunks |
| `ingest/sync.py` | Drive changes → index; archive/removal → de-index; Slack update post |
| `worker/src/retrieve.ts` | Hybrid search (Vectorize + FTS5), TC overlay |
| `worker/src/answer.ts` | Answer rules sent to Claude (citations, verbatim limits, serial groups, chart reads) |
| `worker/src/slack.ts` | Slash command, mentions, DMs, feedback buttons |
| `worker/src/mcp.ts` | MCP tools `ask_jeeves`, `search_library` |
| `schema.sql` | D1 schema |
| `evals/questions.yaml` | Release test set |

Setup: see [SETUP.md](SETUP.md).

Offline test of the ingest: put PDFs under `lib/` in the same folder layout as the shared drive, then
`python -m ingest.sync --local out --source lib`.
