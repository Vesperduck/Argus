# Argus

A Discord bug-reports watcher. On a schedule it reads new messages in a bug-reports channel,
uses Claude to distil them into structured bug reports, proposes each one to the reporters for
confirmation, and on approval files or updates GitHub issues — then reports back to the channel.

See [DESIGN.md](DESIGN.md) for the full design.

## Status

Phase 8 (scheduling) — **implemented**. A daily GitHub Actions cron
([`.github/workflows/argus.yml`](.github/workflows/argus.yml)) runs the full pipeline; see
[Deployment](#deployment-scheduled-runs). All build phases (1–8) are now done — what remains is
operational: set the repo secrets/variables and do a first manual run (which also requires the
token's **Contents: read & write** grant for the state file).

> **GitHub token now needs three things:** Issues: read & write, Contents: read & write, and
> Metadata: read (fine-grained PAT), or the `repo` scope (classic). Verify with
> `npx tsx scripts/diagnose-github.ts`.

> **GitHub token note:** the Issues REST API needs a fine-grained PAT (Issues: read & write +
> Metadata: read) or a classic PAT (`repo`). A deploy key / deployment token is rejected with
> `401 Bad credentials`. Verify with `npx tsx scripts/diagnose-github.ts`.

### Diagnostics / smoke tests

```powershell
$env:NODE_EXTRA_CA_CERTS = "$PWD\.certs\win-ca-bundle.pem"

# Confirm the bot can see the channel and read history
npx tsx scripts/diagnose-discord.ts

# Exercise real ingestion over a time window (default last 7 days; no writes)
$env:ARGUS_SMOKE_SINCE_HOURS = "168"; $env:ARGUS_LOG_LEVEL = "debug"
npx tsx scripts/smoke-ingest.ts

# Run clustering over a window and print bug reports + token cost (spends Anthropic tokens)
$env:ARGUS_SMOKE_SINCE_HOURS = "72"
npx tsx scripts/smoke-cluster.ts

# Full read pipeline incl. merge judgement vs the repo's issues (no writes; Anthropic tokens)
npx tsx scripts/smoke-merge.ts

# GitHub sync check (read-only; add --write to create one deletable [Argus test] issue)
npx tsx scripts/diagnose-github.ts
npx tsx scripts/smoke-github.ts

# Proposal/approval (WRITES a [Argus test] message to the channel; no pings)
npx tsx scripts/smoke-proposal.ts
npx tsx scripts/smoke-proposal.ts read <messageId>   # after reacting

# State persistence (read-only; add --write to commit .argus/state.json round-trip)
npx tsx scripts/smoke-state.ts
npx tsx scripts/smoke-state.ts --write
```

The orchestrator's own `npm run dry-run` "watches from now" on a fresh run (0 messages until
state persistence lands in phase 7), so use `smoke-ingest.ts` to see real fetching.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the secrets
```

Required env: `DISCORD_BOT_TOKEN`, `DISCORD_SOURCE_CHANNEL_IDS` (comma-separated channels to
analyse; single-channel shorthand `DISCORD_SOURCE_CHANNEL_ID`, legacy alias `DISCORD_CHANNEL_ID`),
`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `ARGUS_GITHUB_REPO` (alias `GITHUB_REPO` locally). Optional:
`DISCORD_REVIEW_CHANNEL_ID` (where proposals/summaries post; defaults to the first source channel).
See [.env.example](.env.example) for the full list and defaults.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the orchestrator once (`tsx`). |
| `npm run dry-run` | Run with `--dry-run` — computes the plan, no Discord posts / GitHub writes / state writes. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled output. |

## Deployment (scheduled runs)

Argus runs on a daily GitHub Actions cron ([`.github/workflows/argus.yml`](.github/workflows/argus.yml)),
and can also be triggered manually from the Actions tab (`workflow_dispatch`). Configure these in
the **Argus repo** under Settings → Secrets and variables → Actions:

**Secrets**
- `DISCORD_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `ARGUS_GH_TOKEN` — the fine-grained PAT (Issues + Contents + Metadata) on the target repo.
  Named this way because `GITHUB_TOKEN` is reserved by Actions; the workflow maps it onto the
  app's `GITHUB_TOKEN` env var.

**Variables**
- `ARGUS_GITHUB_REPO` — target repo, e.g. `owner/repo` (Actions forbids `GITHUB_`-prefixed
  variable names, hence the `ARGUS_` prefix)
- `DISCORD_SOURCE_CHANNEL_IDS` — comma-separated channels to analyse (or
  `DISCORD_SOURCE_CHANNEL_ID` for a single channel)
- `DISCORD_REVIEW_CHANNEL_ID` — optional; where proposals/summaries post (defaults to the first
  source channel)
- Optional tuning (defaults apply if unset): `ARGUS_MODEL`, `ARGUS_REQUIRE_APPROVAL`,
  `ARGUS_APPROVERS`, `ARGUS_PROPOSAL_TTL_HOURS`, `ARGUS_MAX_MESSAGES`, `ARGUS_SILENT_WHEN_EMPTY`,
  `ARGUS_STATE_PATH`, `ARGUS_STATE_BRANCH`, `ARGUS_LOG_LEVEL`

**Notes**
- Cron is **UTC** — adjust the schedule in the workflow for your timezone.
- The **first run "watches from now"** (sets the state watermark, processes nothing); real work
  starts on the next run. Trigger it once via `workflow_dispatch` to seed the watermark and
  confirm secrets/variables are correct before relying on the schedule.
- Day-2 onward: each run resolves yesterday's outstanding approvals, then ingests + proposes new.

## Security & secrets

This is a public repo — **no secrets live in it**. All credentials are read from the environment
(`.env` locally, which is gitignored; encrypted Actions secrets in CI). Controls in place:

- **`.gitignore`** excludes `.env` / `.env.*` (except `.env.example`) and `.certs/`.
- **CI secret scan** — [`.github/workflows/secret-scan.yml`](.github/workflows/secret-scan.yml)
  runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history on every push/PR.
- **CI build** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm ci`, typecheck,
  and lint.
- **Local pre-commit guard** ([`.githooks/pre-commit`](.githooks/pre-commit)) — blocks committing
  a `.env` and runs gitleaks on staged changes. Enable it once per clone:

  ```bash
  git config core.hooksPath .githooks
  # optional, so the hook is executable on Unix clones:
  git update-index --chmod=+x .githooks/pre-commit
  ```

**When deploying (e.g. GitHub Actions, Phase 8):** put `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`,
and `GITHUB_TOKEN` in **encrypted repository secrets**, never in workflow YAML. Use least-privilege
tokens (the GitHub PAT needs only Issues + Contents + Metadata, scoped to the one repo).

**If a secret is ever exposed, rotate it immediately:** regenerate the Discord bot token, revoke
the GitHub PAT, and roll the Anthropic API key — rotation is the only real fix, since anything
pushed to a public repo must be assumed captured.

## Troubleshooting

### `npm install` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / "Exit handler never called!"

This machine has a TLS-inspecting proxy/antivirus that re-signs HTTPS with a root CA Node
doesn't trust by default. The fix keeps full TLS verification — it just tells Node to also trust
your Windows root store (which already contains the interceptor's CA). A bundle has been exported
to `.certs/win-ca-bundle.pem` (gitignored). Point Node at it before npm/node commands:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$PWD\.certs\win-ca-bundle.pem"
npm install
```

To regenerate the bundle (e.g. after the CA rotates):

```powershell
$out = ".certs\win-ca-bundle.pem"
$certs = Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA, Cert:\CurrentUser\Root, Cert:\CurrentUser\CA
$certs | ForEach-Object { "-----BEGIN CERTIFICATE-----"; [Convert]::ToBase64String($_.RawData,'InsertLineBreaks'); "-----END CERTIFICATE-----" } | Out-File $out -Encoding ascii
```

Avoid `npm config set strict-ssl false` — that disables verification instead of fixing trust.

## Layout

```
src/
  index.ts        Orchestrator (two-phase: resolve proposals, then detect + propose)
  config.ts       Env loading + validation
  logger.ts       Leveled logger
  types.ts        Shared domain types
  discord/        REST client, ingestion, proposals & summary
  claude/         Anthropic client, clustering, merge judgement
  github/         Octokit client, issue search/create/merge
  state/          Durable state (cursor + pending proposals)
```
