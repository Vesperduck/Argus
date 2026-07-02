/**
 * Clustering smoke test — not part of the build (outside src/).
 * Run: npx tsx scripts/smoke-cluster.ts
 *
 * Fetches a recent window of real messages, runs Claude clustering, and prints
 * the resulting bug reports plus token usage/cost. Costs Anthropic tokens.
 *
 * Tune the window (and cost): ARGUS_SMOKE_SINCE_HOURS=48 npx tsx scripts/smoke-cluster.ts
 * Try a cheaper model:        ARGUS_MODEL=claude-sonnet-4-6 npx tsx scripts/smoke-cluster.ts
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import Anthropic from '@anthropic-ai/sdk';
import { fetchNewMessages } from '../src/discord/ingest.js';
import { clusterMessages } from '../src/claude/cluster.js';
import { resetUsage, usageSummary } from '../src/claude/usage.js';
import type { Config } from '../src/config.js';

const DISCORD_EPOCH = 1420070400000n;

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!token || !channelId || !apiKey) {
  console.error('Need DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, and ANTHROPIC_API_KEY');
  process.exit(1);
}

const model = process.env.ARGUS_MODEL ?? 'claude-opus-4-8';
const hours = Number(process.env.ARGUS_SMOKE_SINCE_HOURS ?? '72');
const maxMessages = Number(process.env.ARGUS_MAX_MESSAGES ?? '500');

const sinceMs = BigInt(Date.now() - hours * 3600 * 1000);
const cursor = ((sinceMs - DISCORD_EPOCH) << 22n).toString();

const rest = new REST({ version: '10' }).setToken(token);
const config = {
  discord: { sourceChannelIds: [channelId] },
  anthropic: { apiKey, model },
  behavior: { maxMessages },
} as unknown as Config;

resetUsage();
console.log(`Fetching last ${hours}h, clustering with ${model}...\n`);

const ingest = await fetchNewMessages(rest, config, channelId, { lastMessageId: cursor });
console.log(`ingested ${ingest.messages.length} message(s)\n`);

const client = new Anthropic({ apiKey });
const bugs = await clusterMessages(client, config, ingest.messages);

console.log(`\n=== ${bugs.length} bug(s) detected ===\n`);
for (const [i, b] of bugs.entries()) {
  console.log(`#${i + 1}  [${b.severity}] ${b.title}`);
  console.log(`     ${b.summary}`);
  if (b.area) console.log(`     area: ${b.area}`);
  console.log(`     reporters: ${b.reporters.join(', ') || '(none)'}`);
  console.log(`     sources: ${b.sourceMessageIds.length} message(s)`);
  if (b.stepsToReproduce?.length) {
    console.log(`     steps: ${b.stepsToReproduce.length} listed`);
  }
  console.log('');
}

console.log('token usage:', usageSummary());
