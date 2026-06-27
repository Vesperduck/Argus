# Argus

A Discord bug-reports watcher. On a schedule it reads new messages in a bug-reports channel,
uses Claude to distil them into structured bug reports, proposes each one to the reporters for
confirmation, and on approval files or updates GitHub issues — then reports back to the channel.

See [DESIGN.md](DESIGN.md) for the full design.

## Status

Phase 7 (state persistence) — **code complete; needs the token's Contents grant**. State
(`{ cursor, pendingProposals }`) persists as a committed `.argus/state.json` in `GITHUB_REPO`
via the Contents API. This closes the cross-run approval loop (propose one run, react, file on
the next). Phases 1–6 are complete. Once the token has **Contents: read & write**, Argus runs
end-to-end; only Phase 8 (scheduling) remains.

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

Required env: `DISCORD_BOT_TOKEN`, `DISCORD_SOURCE_CHANNEL_ID` (channel to analyse; alias
`DISCORD_CHANNEL_ID`), `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`. Optional:
`DISCORD_REVIEW_CHANNEL_ID` (where proposals/summaries post; defaults to the source channel).
See [.env.example](.env.example) for the full list and defaults.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the orchestrator once (`tsx`). |
| `npm run dry-run` | Run with `--dry-run` — computes the plan, no Discord posts / GitHub writes / state writes. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled output. |

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
