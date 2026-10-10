# PVLab Assistant — Cloudflare Pages version

Same app as the Termux/Express version, restructured for Cloudflare Pages
Functions (serverless) so it runs 24/7 without needing your phone on.

## Structure
```
public/index.html            <- the whole frontend (chat UI, calculators, formulas)
functions/api/chat.js        <- main chat endpoint (text + image analysis)
functions/api/execute-python.js  <- Python "Run" button backend (Judge0)
functions/api/health.js      <- health check endpoint
```

Cloudflare automatically turns `functions/api/chat.js` into the route
`/api/chat`, `functions/api/execute-python.js` into `/api/execute-python`,
etc. No Express, no `server.js` — Cloudflare handles routing.

## Deploy via GitHub (same flow as your GetDigitals site)

1. Push this folder to a GitHub repo (new repo, e.g. `pvlab-assistant`, or
   a subfolder of an existing one — just make sure the Cloudflare Pages
   project's "root directory" setting points at wherever `public/` and
   `functions/` live).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages →
   Connect to Git** → select the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. Deploy. Cloudflare will give you a `*.pages.dev` URL immediately —
   this works right away, and you can attach your own domain/subdomain
   later (e.g. `pvlab.yourdomain.com`) the same way you did for
   GetDigitals.

## Environment variables (set in Cloudflare dashboard, NOT in code)

Go to your Pages project → **Settings → Environment variables**, add:

| Variable | Value (demo phase) |
|---|---|
| `PROVIDER` | `groq` |
| `GROQ_API_KEY` | your Groq key |
| `GROQ_MODEL` | `openai/gpt-oss-120b` |

When the client starts paying and you switch to Anthropic later, just
change `PROVIDER` to `anthropic` and add `ANTHROPIC_API_KEY` — no code
changes needed, matches the same design as the Termux version.

**Important:** set these under both "Production" and "Preview"
environments in the dashboard, or preview deployments will fail with a
missing-API-key error.

## Accounts + memory (D1 database)

Signup/login and the per-user memory system (`functions/api/signup.js`,
`login.js`, `memory-get.js`, `memory-save.js`, `import-memory.js`) need a
D1 database bound as `DB`. Without this binding, the site still works
exactly as before for guests — the account button just won't do anything
useful.

1. Cloudflare dashboard → **Workers & Pages → D1 → Create database** (e.g.
   `pvlab-db`).
2. Open the new database → **Console** tab → paste the contents of
   `schema.sql` (in this repo's root) → Execute. This creates the
   `users`, `sessions`, `user_memory`, and `chat_history` tables.
3. Go back to your Pages project → **Settings → Functions → D1 database
   bindings** → Add binding → Variable name `DB` → select `pvlab-db`.
   Do this for both Production and Preview.
4. Redeploy (or it picks it up on the next push).

No wrangler CLI / wrangler.toml needed — this whole setup is done through
the dashboard, same as the GROQ_API_KEY env var above.

Once `DB` is bound and the schema is applied, logged-in users get:
- Auto-extracted memory (preferences/subjects/goals) injected into the system
  prompt on every chat request.
- Per-module chat history synced to D1 (`chat_history` table) — switching
  devices while logged in pulls that module's history from the server
  instead of relying on localStorage. Guests still get the old
  localStorage-only behavior.

## Testing after deploy

Open the `*.pages.dev` URL Cloudflare gives you, from the client's own
network in Algeria (mobile data + home WiFi both) to confirm no regional
blocking issue, before treating this as the final link to share.

## Usage limits (cost control)

Every AI message counts against a per-UTC-day limit, by plan:

| Plan  | Who | Default daily limit | Env var |
|-------|-----|---------------------|---------|
| guest | not logged in (counted per IP) | 5   | `GUEST_DAILY_LIMIT` |
| free  | logged in | 15  | `FREE_DAILY_LIMIT` |
| pro   | `users.plan = 'pro'` (and not expired) | 200 | `PRO_DAILY_LIMIT` |

Image questions count double. Memory imports are capped separately (`IMPORT_DAILY_LIMIT`,
default 3 per user per day). If the AI provider errors, the message is refunded.
Env vars are optional — set them in Pages → Settings → Environment variables to change
the defaults (needs a redeploy).

**Existing database?** Run `migrations/002_usage_limits.sql` once in the D1 console
(adds `users.plan`, `users.plan_expires_at` and the `usage_counts` table). Until you do,
limits fail open (chat keeps working, just unlimited).

**Manually granting a paid plan** (e.g. after a WhatsApp/manual payment), in the D1 console:

```sql
-- 30 days of pro:
UPDATE users SET plan='pro', plan_expires_at=(strftime('%s','now')+30*86400)*1000 WHERE email='student@example.com';
-- pro with no expiry:
UPDATE users SET plan='pro', plan_expires_at=NULL WHERE email='student@example.com';
-- back to free:
UPDATE users SET plan='free', plan_expires_at=NULL WHERE email='student@example.com';
```

Note: Cloudflare's free plan allows only 50 D1 queries per request, so the memory/import
code deliberately uses single-statement trims and in-memory dedupe.

## Document upload (PDF / text)

The 📎 button accepts images, PDFs and .txt/.md files. For PDFs/text, the browser extracts the
text itself (pdf.js, loaded from cdnjs on first use) — nothing is parsed server-side, so it fits
Cloudflare's free-plan CPU limits. The text is split into ~1500-character chunks; for every
question only the most relevant chunks (keyword scoring, ≤ ~9000 characters) are sent to the
AI together with page markers like `[p.12]`. The server caps and sanitizes the excerpts again
and tells the model to treat them as reference material, never as instructions.

- Limits: 15 MB per file, first 300 pages, ~600k characters.
- The document stays attached for follow-up questions until removed or the page is reloaded
  (it is not stored on the server).
- A question about an attached document counts as 2 messages against the daily limit
  (bigger prompts), same as an image question.
- Scanned PDFs (pictures of pages, no text layer) can't be read — there is no OCR.
- Retrieval is simple keyword matching, not embeddings: generic questions ("summarize this")
  sample evenly across the document instead.
