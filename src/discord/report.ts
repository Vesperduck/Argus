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
): Promise<{ discordMessageId: string }> {
  const mentions = bug.reporters.map((id) => `<@${id}>`).join(' ');
  const steps = bug.stepsToReproduce?.length
    ? `**Steps to reproduce:**\n${bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  const content = truncate(
    [
      `🐛 **Proposed bug report** — \`${bug.severity}\``,
      `**${bug.title}**`,
      bug.summary,
      steps,
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
  return { discordMessageId: msg.id };
}

/** Read the ✅/❌ reactions on a proposal message, excluding the bot's own seeds. */
export async function readProposalReactions(
  rest: REST,
  config: Config,
  proposal: Proposal,
): Promise<ReactionVerdict> {
  const botId = await getBotUserId(rest);
  const channelId = config.discord.reviewChannelId;
  const [approve, reject] = await Promise.all([
    reactorIds(rest, channelId, proposal.discordMessageId, APPROVE),
    reactorIds(rest, channelId, proposal.discordMessageId, REJECT),
  ]);
  return {
    approvedBy: approve.filter((id) => id !== botId),
    rejectedBy: reject.filter((id) => id !== botId),
  };
}

/** Edit a resolved proposal message to reflect the outcome (no re-pings). */
export async function updateProposalMessage(
  rest: REST,
  config: Config,
  proposal: Proposal,
  note: string,
): Promise<void> {
  const content = truncate(`${note}\n~~${proposal.bug.title}~~`);
  await rest.patch(Routes.channelMessage(config.discord.reviewChannelId, proposal.discordMessageId), {
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
