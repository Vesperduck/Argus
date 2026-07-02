import { makeURLSearchParams, type REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { APIMessage, APIUser } from 'discord-api-types/v10';
import type { Config } from '../config.js';
import type { BugReport, Proposal, ProposalAction, SyncOutcome } from '../types.js';
import { logger } from '../logger.js';

const APPROVE = '✅';
const REJECT = '❌';
const MAX_CONTENT = 1900; // Discord hard limit is 2000; leave headroom

/** Who reacted ✅ / ❌ on a proposal message (Discord user IDs, bot excluded). */
export interface ReactionVerdict {
  approvedBy: string[];
  rejectedBy: string[];
}

/** Reactions plus the channel the proposal message was actually found in. */
export interface ResolvedReactions {
  verdict: ReactionVerdict;
  channelId: string;
}

/** Thrown when a proposal's message can't be found in any candidate channel. */
export class ProposalMessageGoneError extends Error {}

/** Discord error 10008 — the message id is unknown in the channel queried. */
function isUnknownMessage(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 10008;
}

/** Channels to look for a proposal message in, most-specific first, deduped. */
function candidateChannels(config: Config, proposal: Proposal): string[] {
  const out: string[] = [];
  for (const c of [
    proposal.channelId,
    config.discord.reviewChannelId,
    ...config.discord.sourceChannelIds,
  ]) {
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function truncate(s: string, max = MAX_CONTENT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

let botIdCache: string | undefined;
async function getBotUserId(rest: REST): Promise<string> {
  if (botIdCache) return botIdCache;
  const me = (await rest.get(Routes.user('@me'))) as APIUser;
  botIdCache = me.id;
  return me.id;
}

async function seedReaction(
  rest: REST,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await rest.put(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me` as `/${string}`,
  );
}

async function reactorIds(
  rest: REST,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<string[]> {
  const users = (await rest.get(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}` as `/${string}`,
    { query: makeURLSearchParams({ limit: 100 }) },
  )) as APIUser[];
  return users.map((u) => u.id);
}

function actionLine(action: ProposalAction): string {
  return action.kind === 'create'
    ? '**Action:** open a new GitHub issue'
    : `**Action:** add this to existing issue #${action.issueNumber}`;
}

/**
 * Post a one-off header that introduces a batch of proposals and explains how to
 * review them. Call once per run, before the first proposal, so reporters aren't
 * confused by a wall of bug cards appearing with no context.
 */
export async function postProposalsHeader(rest: REST, config: Config): Promise<void> {
  const ttl = config.behavior.proposalTtlHours;
  const content = truncate(
    [
      '📋 **New bug reports for review**',
      "Argus scanned the bug-reports channel and drafted the reports below from recent messages. Each one needs a quick human check before it's filed on GitHub:",
      `• React ${APPROVE} to confirm it's accurate — Argus files it as a GitHub issue on its next run.`,
      `• React ${REJECT} to dismiss it.`,
      `Reporters are tagged so they can confirm their own reports. Anything left unreviewed expires after ${ttl}h.`,
    ].join('\n'),
  );
  await rest.post(Routes.channelMessages(config.discord.reviewChannelId), {
    body: { content, allowed_mentions: { parse: [] } },
  });
}

/**
 * Post a proposal message tagging the reporters and seed ✅/❌ reactions so
 * approvers just click. Returns the posted message id (stored on the Proposal).
 */
export async function postProposal(
  rest: REST,
  config: Config,
  bug: BugReport,
  action: ProposalAction,
): Promise<{ discordMessageId: string; channelId: string }> {
  const mentions = bug.reporters.map((id) => `<@${id}>`).join(' ');
  const steps = bug.stepsToReproduce?.length
    ? `**Steps to reproduce:**\n${bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  const sources = bug.sourceMessages?.length
    ? `**Original messages:**\n${truncate(
        bug.sourceMessages
          .map((m) => `> **${m.authorName}:** ${m.content.replace(/\s+/g, ' ').trim() || '_(no text)_'}`)
          .join('\n'),
        700,
      )}`
    : '';
  // Say where the report came from when several channels are being watched.
  const origin =
    bug.sourceChannelId && config.discord.sourceChannelIds.length > 1
      ? `**From:** <#${bug.sourceChannelId}>`
      : '';
  const content = truncate(
    [
      `🐛 **Proposed bug report** — \`${bug.severity}\``,
      `**${bug.title}**`,
      bug.summary,
      origin,
      steps,
      sources,
      actionLine(action),
      mentions ? `Reporters: ${mentions}` : '',
      `React ${APPROVE} to confirm and I'll file it, or ${REJECT} to dismiss.`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const msg = (await rest.post(Routes.channelMessages(config.discord.reviewChannelId), {
    body: { content, allowed_mentions: { parse: [], users: bug.reporters } },
  })) as APIMessage;

  // Seed both reactions (sequential — Discord rate-limits reactions tightly).
  await seedReaction(rest, config.discord.reviewChannelId, msg.id, APPROVE);
  await seedReaction(rest, config.discord.reviewChannelId, msg.id, REJECT);

  logger.info(`posted proposal ${msg.id}`, { title: bug.title });
  return { discordMessageId: msg.id, channelId: config.discord.reviewChannelId };
}

/**
 * Read the ✅/❌ reactions on a proposal message, excluding the bot's own seeds.
 * Tries the proposal's stored channel first, then the review and source channels
 * (legacy proposals predate channel tracking, or the review channel may have
 * changed). Returns the channel the message was actually found in so callers can
 * edit it in place and backfill `proposal.channelId`.
 *
 * @throws {ProposalMessageGoneError} if the message is absent from all candidates.
 */
export async function readProposalReactions(
  rest: REST,
  config: Config,
  proposal: Proposal,
): Promise<ResolvedReactions> {
  const botId = await getBotUserId(rest);
  const channels = candidateChannels(config, proposal);
  for (const channelId of channels) {
    try {
      const [approve, reject] = await Promise.all([
        reactorIds(rest, channelId, proposal.discordMessageId, APPROVE),
        reactorIds(rest, channelId, proposal.discordMessageId, REJECT),
      ]);
      return {
        channelId,
        verdict: {
          approvedBy: approve.filter((id) => id !== botId),
          rejectedBy: reject.filter((id) => id !== botId),
        },
      };
    } catch (err) {
      if (isUnknownMessage(err)) continue; // not in this channel — try the next
      throw err;
    }
  }
  throw new ProposalMessageGoneError(
    `proposal message ${proposal.discordMessageId} not found in channel(s) ${channels.join(', ')}`,
  );
}

/** Edit a resolved proposal message to reflect the outcome (no re-pings). */
export async function updateProposalMessage(
  rest: REST,
  config: Config,
  proposal: Proposal,
  note: string,
  channelId: string = proposal.channelId ?? config.discord.reviewChannelId,
): Promise<void> {
  const content = truncate(`${note}\n~~${proposal.bug.title}~~`);
  await rest.patch(Routes.channelMessage(channelId, proposal.discordMessageId), {
    body: { content, allowed_mentions: { parse: [] } },
  });
}

/** Post the end-of-run digest (created / updated / proposed / failed). */
export async function postRunSummary(
  rest: REST,
  config: Config,
  outcomes: SyncOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;

  let created = 0;
  let updated = 0;
  let proposed = 0;
  let skipped = 0;
  let failed = 0;
  const detail: string[] = [];

  for (const o of outcomes) {
    switch (o.action) {
      case 'created':
        created++;
        detail.push(`🆕 ${o.bug.title} — ${o.issue.url}`);
        break;
      case 'updated':
        updated++;
        detail.push(`🔄 ${o.bug.title} — ${o.issue.url}`);
        break;
      case 'proposed':
        proposed++;
        detail.push(`📋 ${o.proposal.bug.title} — awaiting approval`);
        break;
      case 'failed':
        failed++;
        detail.push(`⚠️ ${o.bug.title} — ${o.error}`);
        break;
      case 'skipped':
        skipped++;
        break;
    }
  }

  const header = `**Argus run** — 🆕 ${created} · 🔄 ${updated} · 📋 ${proposed} · ⏭️ ${skipped} · ⚠️ ${failed}`;
  const content = truncate([header, ...detail].join('\n'));

  await rest.post(Routes.channelMessages(config.discord.reviewChannelId), {
    body: { content, allowed_mentions: { parse: [] } },
  });
}
