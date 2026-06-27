# Argus — Design Document

> Argus Panoptes, the all-seeing giant of a hundred eyes. This bot watches a Discord
> bug-reports channel, distils the chatter into structured bug reports with Claude, proposes
> them to the reporters for confirmation, and keeps a GitHub issue tracker in sync.

**Status:** Draft v0.2
**Stack:** TypeScript (Node.js) · `@discordjs/rest` + `discord-api-types` · `@anthropic-ai/sdk` · Octokit
**Execution model:** Stateless scheduled job (serverless / external cron)

**Changelog**
- v0.2 — Added human-in-the-loop **approval workflow** (reaction-based, polled across runs) and
  **thread ingestion** within the text channel. Resolved §10 questions 1 & 5.
- v0.1 — Initial design.

---

## 1. Goal

On a schedule (e.g. daily), Argus:

1. Reads every new message in a Discord bug-reports channel (and its threads) since the last run.
2. Sends that raw material to Claude, which **clusters** related messages and produces one
   detailed, structured bug report per distinct bug.
3. For each bug, works out the intended GitHub action (create a new issue, or merge into an
   existing one) and **posts a proposal back to the channel, tagging the reporters** so they can
   confirm it's correct.
4. On a later run, reads the reactions on each proposal:
   - **Approved** → create the new issue or merge into the existing one.
   - **Rejected** → dismiss.
   - **No response past a TTL** → expire (configurable: drop or auto-file).
5. Posts confirmations (with GitHub issue links) back to the channel.

> If approval is disabled (`ARGUS_REQUIRE_APPROVAL=false`), steps 3–4 collapse into immediate
> create/merge and the run posts a plain summary. Approval is **on by default**.

---

## 2. Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | TypeScript / Node.js | Single-language stack, strong typing across the Discord, Claude, and GitHub boundaries. |
| Discord access | **REST API only** (`@discordjs/rest` + `discord-api-types`), no Gateway | The job is scheduled batch reads + posts + reaction reads. A persistent WebSocket gateway connection is unnecessary and incompatible with a serverless/cron model. |
| Approval mechanism | **Emoji reactions polled across runs**, not buttons | Buttons/slash-interactions need an always-on gateway or a public HTTPS interactions endpoint — both break the cron-only model. Reactions are readable via REST on the next run. |
| Scheduling | External cron (GitHub Actions cron recommended) | No idle process to host. Free, sits next to the target repo, natural home for secrets and state. |
| Claude usage tier | **Workflow + structured outputs** (not an agent) | The pipeline is a fixed sequence we orchestrate in code: extract → match → propose → (later) execute. Claude does classification/summarisation/merge judgement. Simpler and cheaper than an agent. |
| Model | `claude-opus-4-8` with adaptive thinking | Default to the most capable model; clustering + merge judgement benefit from reasoning. Downgrade to `claude-sonnet-4-6` later only if cost demands it. |
| Issue ↔ bug matching | Code-side candidate retrieval (GitHub Search) **then** Claude judges the match | Deterministic narrowing keeps token cost down; Claude makes the semantic call. |
| Idempotency | Durable state (cursor + pending proposals) **plus** fingerprint markers embedded in issues | Survives re-runs, partial failures, and the asynchronous approval gap without double-filing. |

---

## 3. Architecture

```
                       ┌──────────────────────────┐
   cron trigger ──────▶│        Orchestrator       │
   (daily)             └────────────┬─────────────┘
                                    │
   ┌─────────── Phase A: resolve pending proposals ───────────┐
   │  read reactions ▶ approver policy + TTL ▶ execute approved │
   │  GitHub create/merge ▶ post confirmations                 │
   └───────────────────────────────────────────────────────────┘
                                    │
   ┌─────────── Phase B: detect + propose new bugs ───────────┐
   │  Discord ingest (channel + threads, since cursor)         │
   │        ▼                                                   │
   │  Claude cluster ▶ BugReport[]                              │
   │        ▼                                                   │
   │  dedup vs issue fingerprints + pending proposals          │
   │        ▼                                                   │
   │  GitHub candidate search ▶ Claude match decision          │
   │        ▼                                                   │
   │  post proposal (tag reporters, seed ✅/❌)  ──▶ pending     │
   └───────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    advance cursor + persist state (on success)
```

Each module has a narrow interface and is built/tested independently (see §9).

---

## 4. Components

### 4.1 Orchestrator
Single entry point invoked by the scheduler. Responsibilities:
- Load config + secrets and durable state (cursor + pending proposals).
- **Phase A:** resolve outstanding proposals (reactions → approve/reject/expire → execute).
- **Phase B:** ingest new messages, cluster, dedup, decide, and post new proposals.
- **Only advance the cursor on a clean run** (see §7).
- Always emit a summary so humans see what happened.
- Honour `--dry-run`: compute and log the plan, perform no Discord posts / GitHub writes /
  state persistence.

### 4.2 Discord ingestion (REST)
- Main channel: `GET /channels/{channel.id}/messages` (paginated, 100/page, `after=<cursor>`).
- **Threads:** the channel is a plain text channel, but reporters sometimes spin up threads.
  So ingestion also enumerates the channel's **active threads** (`GET /guilds/{guild}/threads/active`,
  filtered to this channel) and **archived public threads**
  (`GET /channels/{channel.id}/threads/archived/public`), and reads each thread's messages with
  the same `after` cursor logic. Thread messages are normalised with `threadId` set.
- Normalise each message to `RawMessage` (see [src/types.ts](src/types.ts)): id, channel/thread
  id, author id + name, ISO timestamp, content, attachments, optional `replyToId`.
- Bound volume per run (`ARGUS_MAX_MESSAGES`); carry overflow to the next run.

> Cursor across threads: a single global snowflake cursor works because snowflakes are globally
> time-ordered. v1 uses one cursor for the channel + its threads; if a thread receives a late
> edit-storm this can re-scan a thread — harmless, since dedup (§6) makes it idempotent.

### 4.3 Claude analysis
Two discrete calls (kept separate for testability), both using `claude-opus-4-8`,
`thinking: { type: "adaptive" }`, **structured outputs** (`output_config.format` with a JSON
schema via the SDK's `zodOutputFormat` helper), and streaming.

**(a) Cluster + summarise.** Input: the batch of `RawMessage`s. Output: `BugReport[]`, with
messages about the same underlying bug merged into one report. Schema fields: `title`, `summary`,
`description`, `stepsToReproduce`, `severity`, `area`, `sourceMessageIds`, `reporters`.

**(b) Merge judgement.** Input: a new bug + a shortlist of candidate existing issues. Output:
`{ issueNumber: number | null, newInformation: string }`. Code narrows candidates first; Claude
makes the semantic call.

> Token-cost note: the message batch is the volatile, per-run part of the prompt; the schema and
> instructions are stable. Order the prompt stable-first with a `cache_control` breakpoint after
> the instructions so the fixed prefix is cached across the per-bug merge calls.

### 4.4 Discord proposals & approval
This is the human-in-the-loop layer. It spans two runs.

**Posting a proposal (Phase B):** (to the **review** channel)
- `POST /channels/{review.id}/messages` with the bug summary + the intended GitHub action
  ("will open a new issue" / "will add detail to #123"), **mentioning the reporters**
  (`<@userId>`, with `allowed_mentions` set so the ping lands).
- The bot seeds ✅ and ❌ reactions on its own message so approvers just click.
- The proposal (bug payload, intended action, message id, `pending` state, timestamp) is saved
  to durable state.

**Resolving a proposal (Phase A, next run):**
- `GET /channels/{channel.id}/messages/{message.id}/reactions/{emoji}` for ✅ and ❌.
- **Approver policy** (`ARGUS_APPROVERS`): `reporters` (default — only the tagged users count),
  `anyone`, or an explicit user-ID allowlist.
- Outcome: **approved** (an authorised ✅) → execute the stored GitHub action; **rejected** (an
  authorised ❌) → dismiss; **expired** (age > `ARGUS_PROPOSAL_TTL_HOURS`) → drop with a note
  (or auto-file, configurable); else **still pending** → leave for a future run.
- On approval/rejection, edit the proposal message to reflect the outcome and (if filed) the
  issue link.

### 4.5 GitHub sync
- **Candidate retrieval (code):** query the Issues Search API with keywords from the bug
  title/area, scoped to the repo and the `argus` label (open + recently closed). Shortlist only.
- **Create:** open an issue; body carries the structured report **plus a hidden fingerprint
  marker** (§6). Labels: `argus`, severity, area.
- **Merge:** append `newInformation` as a comment (audit trail) and update the fingerprint
  marker's `sources`.
- Token needs **Issues: read & write**.

### 4.6 State store
Durable across stateless invocations. Holds **cursor + pending proposals**:
```jsonc
{
  "cursor": { "lastMessageId": "<snowflake>", "lastRunAt": "<ISO>" },
  "pendingProposals": [
    {
      "id": "<uuid>",
      "discordMessageId": "<snowflake>",
      "bug": { /* BugReport */ },
      "action": { "kind": "create" },           // or { kind: "merge", issueNumber, newInformation }
      "state": "pending",
      "proposedAt": "<ISO>"
    }
  ]
}
```
Backends, in recommended order: **private Gist** (default, no repo commit noise) → committed
`.argus/state.json` → external KV. The pending-proposals list grows the payload modestly; a Gist
handles it comfortably.

---

## 5. Data flow (one run)

**Phase A — resolve pending proposals**
1. For each pending proposal: read ✅/❌ reactions, apply approver policy + TTL.
2. Approved → GitHub create/merge (with fingerprint), edit message with issue link, drop from
   pending. Rejected → edit message, drop. Expired → per policy, drop. Else keep.

**Phase B — detect + propose**
3. Load cursor; fetch messages (channel + threads) `after=lastMessageId`; normalise.
4. If empty → optional "nothing new", persist resolved-proposal state, exit without advancing
   cursor.
5. Claude (a): messages → `BugReport[]`.
6. **Dedup:** drop bugs whose `sourceMessageIds` are already covered by an existing issue's
   fingerprint **or** a currently-pending proposal.
7. For each remaining bug: GitHub candidate search → Claude (b) match decision. Post a proposal
   (tag reporters, seed reactions), add to pending. *(If approval disabled: execute immediately.)*

**Finish**
8. Emit run summary.
9. On full success, advance cursor to the newest fetched message ID; persist state.

---

## 6. Idempotency & deduplication

Three things must never produce duplicates: re-runs, partial failures, and the approval gap
(a bug stays pending across runs while new messages about it keep arriving).

- **Fingerprint marker in every Argus-managed issue** — a hidden HTML comment listing the
  Discord message IDs already folded in:
  ```html
  <!-- argus:v1 fingerprint=<hash> sources=<msgId,msgId,...> -->
  ```
  Merges skip already-present source IDs, so reprocessing a window is a no-op.
- **Pending-proposal dedup** — a bug whose sources overlap an open proposal is skipped (not
  re-proposed). *(Augmenting an open proposal with newly-arrived detail is a fast-follow.)*
- **Cursor only advances on success** — a mid-run crash re-reads the same window next time; the
  fingerprint + pending layers absorb the overlap.

Correctness rests on the markers and pending list, not on a perfect cursor (which is just an
efficiency optimisation).

---

## 7. Failure handling

- **Per-bug isolation:** a failure on one bug is recorded and surfaced in the summary; others
  proceed.
- **Cursor discipline:** advance only if every bug in the run was handled without error.
- **Claude refusals / truncation:** structured outputs guarantee shape; still check `stop_reason`
  (`refusal`, `max_tokens`) before trusting `content`, and fail loudly.
- **Rate limits:** discord.js REST and Octokit retry/backoff; the Anthropic SDK retries 429/5xx
  automatically. Bound batch sizes.

---

## 8. Configuration & secrets

| Name | Purpose | Default |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Read history, post, read reactions | — (secret) |
| `DISCORD_SOURCE_CHANNEL_ID` | Channel to analyse for bug reports (alias: `DISCORD_CHANNEL_ID`) | — |
| `DISCORD_REVIEW_CHANNEL_ID` | Channel to post proposals + summaries to | source channel |
| `ANTHROPIC_API_KEY` | Claude API | — (secret) |
| `GITHUB_TOKEN` | Issue search/create/comment | — (secret) |
| `GITHUB_REPO` | `owner/repo` target | — |
| `STATE_GIST_ID` | Cursor + proposals storage (Gist backend) | — |
| `ARGUS_MODEL` | Claude model | `claude-opus-4-8` |
| `ARGUS_MAX_MESSAGES` | Per-run ingest cap | `500` |
| `ARGUS_REQUIRE_APPROVAL` | Human-in-the-loop on/off | `true` |
| `ARGUS_APPROVERS` | `reporters` \| `anyone` \| comma-sep user IDs | `reporters` |
| `ARGUS_PROPOSAL_TTL_HOURS` | When a pending proposal expires | `72` |
| `ARGUS_SILENT_WHEN_EMPTY` | Suppress "nothing new" posts | `false` |

Discord bot needs, on the **source** channel: **View Channel** + **Read Message History** (incl.
threads); on the **review** channel: **View Channel**, **Send Messages**, **Read Message History**,
**Add Reactions**. Plus the **Message Content** privileged intent, and guild scope to enumerate
active threads. (When source and review are the same channel, it needs all of the above.)

---

## 9. Implementation phases

Each phase is independently runnable/testable; the orchestrator is wired last.

1. **Skeleton & config** — TS scaffold, config + secret loading (zod), typed module interfaces,
   `--dry-run`, orchestrator skeleton over stubs. ✅
2. **Discord ingestion** — fetch + normalise channel **and thread** messages since a cursor.
   Verified live against the target channel (incl. threads). ✅
3. **Claude clustering** — `RawMessage[]` → `BugReport[]` via structured outputs
   (`output_config.format` + adaptive thinking), with per-call token/cost tracking. Verified
   live: cleanly separated real bugs from chatter. ✅
4. **GitHub sync** — candidate search, create-issue with fingerprint, merge-via-comment.
   Verified live (read + write) against the target repo. ✅
5. **Claude merge judgement** — wire candidates into the match decision; orchestrator dedup
   (fingerprint + pending-proposal). Verified live (read pipeline). ✅
6. **Discord proposals & approval** — post proposals (tag reporters, seed reactions), read
   reactions, apply approver policy + TTL, post confirmations. Implemented; proposal posting +
   reaction read-back live-testable now, full cross-run loop testable after phase 7. ✅
7. **State store + orchestrator** — cursor + pending proposals persisted as a committed
   `.argus/state.json` (GitHub Contents API), end-to-end wiring. Code complete; live verification
   pending the token's **Contents: read & write** grant. ◀ *current*
8. **Scheduling** — GitHub Actions cron workflow; secrets; first live run.
9. **Hardening** — forum-channel support, augment-pending-proposals, observability, cost tuning,
   failure alerting.

---

## 10. Open questions

- ~~Channel shape~~ — **Resolved:** plain text channel; reporters sometimes create threads, so
  ingestion covers channel + threads (§4.2).
- ~~Human-in-the-loop~~ — **Resolved:** propose-then-approve via reactions, tagging reporters
  (§4.4). Approval is on by default.
- **Approver scope** — default is the bug's reporters; should a maintainer role also be able to
  approve/override? (Configurable via `ARGUS_APPROVERS`; default `reporters`.)
- **Expiry behaviour** — when a proposal hits its TTL with no response: drop silently, drop with
  a note, or auto-file? (v1: drop with a note.)
- **Issue labels/templates** — any existing label scheme or issue template to conform to?
- **Volume** — rough messages/day? Drives batch caps and model/cost choices.
- **Closed issues** — should a re-reported bug reopen a closed issue, or open a fresh linked one?

---

## 11. Future enhancements (backlog)

Ideas captured for later, not yet scheduled.

### 11.1 Thread-based corrections on proposals

Today a reviewer can only **approve (✅)** or **dismiss (❌)** a proposal. Allow a third path:
a reviewer **starts a thread off the proposal message** and notes corrections / extra detail
there (e.g. "severity should be high", "also happens on controller", "wrong area — this is UI").
On the next run, Argus reads the proposal's thread and **incorporates the corrections before
filing** rather than filing the draft verbatim.

Sketch of how it'd work:
- A thread started from a message has the **same id as that message**, so during Phase A
  resolution Argus can fetch `GET /channels/{proposalMessageId}/messages` (the thread) for each
  pending proposal and collect any human replies (excluding the bot).
- If correction messages exist, pass the original `BugReport` + the correction text back through
  a Claude "revise" call (structured output) to produce an updated `BugReport`, then file/merge
  that instead of the original.
- Interaction with the approve/deny flow:
  - Corrections **without** a ✅ → revise the proposal in place (edit the message to show the
    updated draft) and keep it pending for another review cycle, or auto-apply depending on a
    config flag.
  - Corrections **with** a ✅ → apply corrections, then file.
  - Decide precedence when a ❌ and corrections coexist (likely ❌ wins / dismiss).
- New state: the proposal may need to track the last-seen thread message id so corrections
  aren't reprocessed each run (same cursor idea as ingestion).
- Config: whether corrected proposals auto-file or require a fresh ✅ after revision.

Open questions: who may correct (reuse `ARGUS_APPROVERS`?), how to surface the revised draft
clearly, and how corrections should read once the issue is filed (fold into the body vs. note
as a comment).
