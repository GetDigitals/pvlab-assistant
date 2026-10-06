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
