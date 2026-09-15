# Sports betting prediction orchestrator

n8n workflow that pulls multi-sport odds, de-vigs them into fair probabilities, asks an LLM
(Cloudflare Workers AI) for a value read, and stores results — in INR and USD — for a
dashboard. Built for reliability, not for guaranteed wins: see "What this can and can't do"
at the bottom.

## Pieces

| Piece | What it does |
|---|---|
| `n8n-workflow.json` | Main orchestrator. Schedule → fetch odds per sport → compute implied probabilities → LLM pick → post to backend. |
| `n8n-error-workflow.json` | Catches any unhandled crash in the main workflow and logs it, so a failure never fails silently. |
| `backend/` | Small Express API. Ingests from n8n, serves the dashboard, tracks accuracy. File-based storage — no database server to set up. |
| `frontend/` | The dashboard (`index.html`), served automatically by the backend. |

## Setup

### 1. Backend
```bash
cd backend
npm install
npm start
```
Runs on `http://localhost:3000`. The dashboard is served at the same address.

### 2. n8n
1. Import both `n8n-workflow.json` and `n8n-error-workflow.json` (Workflows → Import from File).
2. Open the **Config** node in the main workflow and fill in:
   - `ODDS_API_KEY` — from [the-odds-api.com](https://the-odds-api.com)
   - `CF_ACCOUNT_ID` / `CF_API_TOKEN` — from your Cloudflare dashboard (Workers AI page → "Use REST API")
   - `CF_MODEL` — any Workers AI model, e.g. `@cf/meta/llama-3.1-8b-instruct`
   - `BACKEND_URL` — `http://localhost:3000` for local, or wherever you deploy the backend
   - `SPORTS` — comma-separated sport keys from `the-odds-api.com`'s `/v4/sports` list (e.g. `basketball_nba,soccer_epl,cricket_ipl`)
3. In the main workflow's **Settings**, set **Error Workflow** to the imported error-handler workflow.
4. Activate both workflows.

The workflow runs every 30 minutes by default — change the **Every 30 Minutes** node if you want a different cadence.

### 3. Recording actual outcomes (for the accuracy tracker)
Once a game finishes, tell the backend what happened:
```bash
curl -X POST localhost:3000/api/results \
  -H 'Content-Type: application/json' \
  -d '{"event_id": "<event_id from the prediction>", "actual_winner": "Lakers"}'
```
This is manual for now. If you want it automated, add a second, slower-running n8n workflow
that polls the Odds API's `/v4/sports/{sport}/scores` endpoint for completed games and posts
the result here automatically — that's the natural next addition.

## How the reliability layer works

- **Every external call retries** (3 attempts, backoff) before it's treated as failed.
- **A failed sport doesn't kill the run.** `continueOnFail` + an explicit `Has Error?` branch
  means one bad odds response gets logged and the loop moves to the next sport.
- **A malformed LLM reply degrades safely.** If the model doesn't return parseable JSON, the
  pipeline records `no_bet` with `llm_parse_failed: true` instead of crashing — and you can see
  exactly how often that happens via `GET /api/accuracy`.
- **Anything unhandled goes to the error workflow**, which logs it via `POST /api/errors`
  instead of failing invisibly. Check `GET /api/errors` to see what broke and when.
- **The store writes atomically** (write-then-rename), so a crash mid-write can't corrupt data.

## Currency handling

Each prediction is stamped with the USD→INR rate ([frankfurter.dev](https://frankfurter.dev),
free, no key) at generation time. Odds themselves are dimensionless (decimal odds), so nothing
about them is "converted" — only the stake and payout figures the dashboard computes are
currency-dependent. Toggle INR/USD on the dashboard to see both.

## GitHub

Suggested repo layout — this project as-is maps directly to it:
```
.
├── n8n-workflow.json
├── n8n-error-workflow.json
├── backend/
├── frontend/
└── README.md
```
- Add a `.gitignore` with `backend/node_modules/` and `backend/data/` (the latter is your
  runtime data, not source — don't commit generated predictions).
- n8n (self-hosted or Cloud with a paid plan) has a built-in **source control** feature that
  syncs workflow JSON to a git repo directly — turn it on in n8n's settings and it'll push
  `n8n-workflow.json`-equivalents on every save, keeping your repo and your live workflow in
  sync automatically instead of manual export/import.
- For deployment: the backend is a plain Node/Express app — it runs on Render, Railway, Fly.io,
  or a small VPS as-is. n8n needs to run somewhere reachable by the internet if you're not
  running it locally (n8n Cloud, or self-hosted via Docker).

## What this can and can't do

This pipeline is engineered so the *system* doesn't fail — it won't crash, drop data, or go
silent when an API hiccups. It cannot make sports outcomes predictable. The LLM's "confidence"
is a language-model estimate reading market data, not a calibrated probability, and no amount
of prompt engineering changes that. Treat `GET /api/accuracy` as the actual scoreboard: if it
doesn't beat just betting the market-implied favorite over a real sample size, the model isn't
adding value yet, and that's worth knowing before staking real money on it. This isn't
financial advice — it's a tool for organizing information, and the accuracy tracker exists
specifically so you don't have to take its picks on faith.
