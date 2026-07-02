/**
 * Proposal/approval smoke test — not part of the build (outside src/).
 *
 * Post a test proposal (WRITES a message to the channel; reporters empty so no
 * pings; clearly labelled "[Argus test]"):
 *   npx tsx scripts/smoke-proposal.ts
 *
 * After reacting ✅/❌ in Discord, read the verdict back:
 *   npx tsx scripts/smoke-proposal.ts read <messageId>
 *
 * Delete the test message when done.
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { postProposal, postProposalsHeader, readProposalReactions } from '../src/discord/report.js';
import type { Config } from '../src/config.js';
import type { BugReport, Proposal } from '../src/types.js';

const token = process.env.DISCORD_BOT_TOKEN;
// Proposals are posted to the review channel.
const channelId =
  process.env.DISCORD_REVIEW_CHANNEL_ID ??
  process.env.DISCORD_SOURCE_CHANNEL_ID ??
  process.env.DISCORD_CHANNEL_ID;
if (!token || !channelId) {
  console.error('Need DISCORD_BOT_TOKEN and a channel (DISCORD_REVIEW_CHANNEL_ID / DISCORD_CHANNEL_ID)');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const config = {
  discord: { reviewChannelId: channelId },
  behavior: { proposalTtlHours: 72 },
} as unknown as Config;

const mode = process.argv[2];

if (mode === 'read') {
  const messageId = process.argv[3];
  if (!messageId) {
    console.error('Usage: npx tsx scripts/smoke-proposal.ts read <messageId>');
    process.exit(1);
  }
  const proposal = { discordMessageId: messageId, bug: { reporters: [] } } as unknown as Proposal;
  const { verdict, channelId } = await readProposalReactions(rest, config, proposal);
  console.log(`reactions (bot excluded, found in channel ${channelId}):`, verdict);
} else {
  const bug: BugReport = {
    title: '[Argus test] proposal — safe to delete',
    summary: 'Test proposal posted by the Argus phase-6 smoke test.',
    description: '',
    stepsToReproduce: ['Open the squad roster', 'Remove a guard', 'Observe the blank entry'],
    severity: 'low',
    sourceMessageIds: ['smoke-1'],
    sourceMessages: [
      {
        id: 'smoke-1',
        authorId: '000000000000000000',
        authorName: 'smoke-tester',
        createdAt: new Date().toISOString(),
        content: 'Removing a guard from the roster leaves a blank entry behind.',
      },
    ],
    reporters: [],
  };
  await postProposalsHeader(rest, config);
  const { discordMessageId } = await postProposal(rest, config, bug, { kind: 'create' });
  console.log(`posted header + proposal message id: ${discordMessageId}`);
  console.log(`React ✅/❌ in Discord, then: npx tsx scripts/smoke-proposal.ts read ${discordMessageId}`);
}
