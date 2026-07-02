/**
 * Ingestion smoke test — not part of the build (outside src/).
 * Run: npx tsx scripts/smoke-ingest.ts
 *
 * Seeds a cursor from a time window (default: last 7 days) and runs the real
 * fetchNewMessages against the configured channel + its threads, so ingestion
 * can be exercised before state persistence (phase 7) exists. Only needs the
 * Discord env vars, not the Anthropic/GitHub ones.
 *
 * Tune the window: ARGUS_SMOKE_SINCE_HOURS=72 npx tsx scripts/smoke-ingest.ts
 * See thread enumeration: ARGUS_LOG_LEVEL=debug npx tsx scripts/smoke-ingest.ts
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { fetchNewMessages } from '../src/discord/ingest.js';
import type { Config } from '../src/config.js';

const DISCORD_EPOCH = 1420070400000n;

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
if (!token || !channelId) {
  console.error('Need DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in environment/.env');
  process.exit(1);
}

const hours = Number(process.env.ARGUS_SMOKE_SINCE_HOURS ?? '168');
const maxMessages = Number(process.env.ARGUS_MAX_MESSAGES ?? '500');

// Discord snowflakes encode their creation time, so a timestamp converts to a
// usable cursor: ((unix_ms - DISCORD_EPOCH) << 22).
const sinceMs = BigInt(Date.now() - hours * 3600 * 1000);
const cursor = ((sinceMs - DISCORD_EPOCH) << 22n).toString();

const rest = new REST({ version: '10' }).setToken(token);

// fetchNewMessages only reads behavior.maxMessages from config.
const config = {
  discord: { sourceChannelIds: [channelId] },
  behavior: { maxMessages },
} as unknown as Config;

console.log(`Smoke test: messages from the last ${hours}h (seeded cursor ${cursor})\n`);

const result = await fetchNewMessages(rest, config, channelId, { lastMessageId: cursor });

console.log(`\nfetched ${result.messages.length} message(s); newCursor=${result.newCursor}`);
for (const m of result.messages) {
  const where = m.threadId ? `thread:${m.threadId}` : 'channel';
  const att = m.attachments.length ? ` [+${m.attachments.length} attachment(s)]` : '';
  const preview = m.content.slice(0, 100).replace(/\s+/g, ' ').trim();
  console.log(`  ${m.createdAt}  ${m.authorName}  (${where})  ${preview}${att}`);
}
