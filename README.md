# 📡 Job Radar

A daily job-finding agent for radio / telecommunications engineering roles around
Melbourne, feeding an iPhone home-screen widget.

**How it works:** every morning at ~6am Melbourne time, a GitHub Action searches job
APIs, filters and ranks the results against [preferences.json](preferences.json)
(role, mid-level experience, A$110k+ salary floor, Melbourne area), and commits the
top matches to [data/jobs.json](data/jobs.json). A
[Scriptable](https://apps.apple.com/app/scriptable/id1405459188) widget on your
iPhone reads that file and shows the top matches — tap a job to open the listing.

```
GitHub Action (daily 6am) ──> job APIs ──> score + rank ──> data/jobs.json
                                                                 │
iPhone widget (Scriptable) <────────── reads via GitHub API ─────┘
```

---

## Setup

### 1. Adzuna API keys (recommended — main source of Australian jobs)

Without these, only The Muse is searched, which has very few Melbourne telecom roles.

1. Register free at <https://developer.adzuna.com> (takes ~2 minutes).
2. Copy your **Application ID** and **Application Key** from the dashboard.
3. Add them as repository secrets — either on GitHub under
   *Settings → Secrets and variables → Actions*, or from a terminal:

   ```bash
   gh secret set ADZUNA_APP_ID --repo nathan13vaughan/job-radar
   ```

   ```bash
   gh secret set ADZUNA_APP_KEY --repo nathan13vaughan/job-radar
   ```

The free tier allows 1,000 calls/month; this project uses ~150.

### 2. Claude re-ranking (optional, recommended)

With Claude ranking enabled, Claude reads each day's candidate list and picks the
best matches with a one-line "why it fits" reason shown on the widget, applying the
strict 3–5 year experience band. Without it, a keyword/salary/recency scoring
formula is used instead. Two ways to enable it — pick **one**:

**Option A — Claude subscription (no extra cost if you have Claude Pro/Max):**

1. In a terminal on your computer, run:

   ```bash
   claude setup-token
   ```

   It opens a browser to authorise, then prints a long-lived token (valid ~1 year).
2. Add it as a secret:

   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo nathan13vaughan/job-radar
   ```

The daily run uses a small slice of your plan's usage quota instead of billing.

**Option B — Anthropic API key (pay per use):**

1. Create a key at <https://platform.claude.com> (Console → API keys).
2. Add it as a secret:

   ```bash
   gh secret set ANTHROPIC_API_KEY --repo nathan13vaughan/job-radar
   ```

Cost is roughly US$0.05–0.15 per day. If both secrets are set, the API key is
used first and the subscription is the fallback.

### 3. iPhone widget

This repo is **private** (so your job hunt isn't public), which means the widget
needs a read-only token to fetch `data/jobs.json`:

1. **Create the token:** on GitHub go to *Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token*
   (<https://github.com/settings/personal-access-tokens/new>):
   - **Repository access:** "Only select repositories" → `job-radar`
   - **Permissions:** Contents → **Read-only** (nothing else)
   - Expiration: up to a year; copy the token (`github_pat_…`).
2. **Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)** (free)
   on your iPhone.
3. **Add the script:** open [widget/JobRadar.js](widget/JobRadar.js) in the GitHub
   app or mobile site, copy the whole file, then in Scriptable tap **+**, paste, and
   name it `JobRadar`. Paste your token into the `TOKEN = ""` line at the top.
4. **Add the widget:** long-press the home screen → **Edit** → **Add Widget** →
   Scriptable → pick a size (medium shows 3 jobs, large shows 6 with reasons) →
   long-press the widget → **Edit Widget** → Script: `JobRadar`, When Interacting:
   **Run Script**.

Tapping a job row opens the listing; tapping elsewhere (or running the script in
the app) opens a full list of all matches.

> Prefer zero-token setup? Make the repo public
> (`gh repo edit nathan13vaughan/job-radar --visibility public`) and the widget
> works with `TOKEN = ""` — at the cost of your job preferences being visible.

---

## Tuning your preferences

Edit [preferences.json](preferences.json) — roles searched, salary floor, keywords
that boost a job's score, and title words that exclude a job outright. Commit the
change; the next run picks it up. Trigger an immediate refresh with:

```bash
gh workflow run find-jobs.yml --repo nathan13vaughan/job-radar
```

## Files

| File | Purpose |
|---|---|
| `preferences.json` | What you're looking for — edit this |
| `scripts/find_jobs.mjs` | The agent: fetch → filter → score → (Claude) rank |
| `.github/workflows/find-jobs.yml` | Daily schedule (20:00 UTC ≈ 6–7am Melbourne) |
| `data/jobs.json` | Output the widget reads (auto-committed) |
| `widget/JobRadar.js` | Scriptable widget for the iPhone |
