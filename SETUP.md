# Jeeves setup runbook

Work top to bottom. Commands run in **Terminal on the Mac Mini** (a plain window, not Claude Code) from the `jeeves` folder unless noted. Never paste keys or tokens into chat or into files in this repo; they go only into the secret stores named below.

## 0. Prerequisites
- GitHub: private repo `jeeves` under the Merci Jets account, this code pushed to it.
- Anthropic Console account with billing and an API key.
- Cloudflare account (the one hosting the alternate-airport tool).
- Node 20+ on the Mac Mini: `brew install node` if `node --version` fails.

## 1. Cloudflare resources (about 10 min)
```
cd worker && npm install
npx wrangler login                                  # opens a browser; approve
npx wrangler d1 create jeeves                       # copy the database_id it prints
```
Put that `database_id` into `worker/wrangler.toml`, then:
```
npx wrangler d1 execute jeeves --remote --file=../schema.sql
npx wrangler d1 execute jeeves --remote --file=../seed/aircraft.sql
npx wrangler vectorize create jeeves --dimensions=768 --metric=cosine
npx wrangler r2 bucket create jeeves-library
```
In the Cloudflare dashboard:
- **R2 → Manage R2 API tokens → Create API token**, permission *Object Read & Write*, bucket `jeeves-library`. Keep the Access Key ID and Secret for step 4.
- **My Profile → API Tokens → Create Token → Custom**, permissions: *Account · D1 · Edit*, *Account · Vectorize · Edit*, *Account · Workers AI · Read*. Keep the token for step 4.
- Note your **Account ID** (right sidebar of the account home page).

## 2. Google service account (about 10 min)
1. console.cloud.google.com → create project `merci-jeeves` (under the Merci Jets organization).
2. APIs & Services → Library → enable **Google Drive API**.
3. IAM & Admin → Service Accounts → Create `jeeves-sync`. No roles needed.
4. Open it → Keys → Add key → JSON. A file downloads. Keep it for step 4, then delete it from Downloads.
5. In Google Drive, open **Jeeves Library → Manage members** → add the service account's email (`jeeves-sync@merci-jeeves.iam.gserviceaccount.com`) as **Viewer**.
6. The Shared Drive ID is the part after `/folders/` when you open the drive's top level in a browser. Jeeves Library's is `0AIwZB2r5Cu8EUk9PVA`.

If step 4 is blocked ("key creation is disabled"), your Workspace has the default org policy on. In Google Cloud → IAM → Organization Policies, turn off *Disable service account key creation* for this project only.

## 3. Deploy the Worker
```
cd worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put LINK_SECRET        # paste any long random string
npx wrangler secret put API_TOKEN          # another long random string
npx wrangler deploy
```
**Hostname:** if `mercijets.com` DNS is on Cloudflare, add a Custom Domain `jeeves.mercijets.com` under Workers → jeeves → Settings → Domains. Otherwise use the `jeeves.<account>.workers.dev` URL wrangler prints, and set `PUBLIC_BASE_URL` in `wrangler.toml` to it.

Check: open `https://<your-host>/health`. It shows `documents: 0` until the first sync.

## 4. GitHub secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | entire contents of the JSON key file from step 2 |
| `JEEVES_SHARED_DRIVE_ID` | `0AIwZB2r5Cu8EUk9PVA` |
| `CF_ACCOUNT_ID` | from step 1 |
| `CF_API_TOKEN` | custom API token from step 1 |
| `D1_DATABASE_ID` | from step 1 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 token from step 1 |
| `SLACK_UPDATES_WEBHOOK` | optional, from step 6 |

## 5. First sync
GitHub → Actions → *Sync Jeeves library* → **Run workflow**. The first run indexes ~130 documents (~3,000 pages) and takes 15–30 minutes. After that it runs hourly and only touches changed files. `/health` should then show the document count.

## 6. Slack
1. api.slack.com/apps → **Create New App → From an app manifest** → Merci Jets workspace → paste `slack/manifest.yml` (fix the hostname if you are using workers.dev).
2. Install to workspace.
3. Copy **Signing Secret** (Basic Information) and **Bot User OAuth Token** (OAuth & Permissions):
   ```
   npx wrangler secret put SLACK_SIGNING_SECRET
   npx wrangler secret put SLACK_BOT_TOKEN
   ```
4. Create channel `#jeeves-updates`. Add an **Incoming Webhook** to the app for that channel, and put the URL in the `SLACK_UPDATES_WEBHOOK` GitHub secret.
5. Invite Jeeves to trip channels: `/invite @Jeeves`.

## 7. Connect Claude (MCP)
In Claude Code on the Mac Mini:
```
claude mcp add --transport http jeeves https://<your-host>/mcp --header "Authorization: Bearer <API_TOKEN from step 3>"
```
Then: "Ask Jeeves for the TCAS supplement limitations." (Connecting it to claude.ai needs an OAuth sign-in in front of `/mcp`; that comes with the web portal and Cloudflare Access.)

## 8. Before crews use it
- Confirm N702FL's SB750-71-10 status and update `seed/aircraft.sql` (re-run the d1 execute line). Add each new tail as it joins.
- Verify and complete `evals/questions.yaml` (target 50 questions plus 10 chart reads), run it, and fix misses.
- Chart reading stays internal until it passes the chart-read set.

## Day-to-day
- New revision: drop it in the right folder, move the old one to `_Archive`. Within the hour Jeeves re-indexes it and posts to `#jeeves-updates`.
- `_Archive` and `_Review` are never indexed.
- Thumbs-down feedback is stored in D1 `questions`; review it weekly.
