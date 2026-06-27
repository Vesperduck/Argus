/**
 * Merge-judgement smoke test — not part of the build (outside src/).
 * Run: npx tsx scripts/smoke-merge.ts
 *
 * Full READ pipeline, no writes: ingest a recent window -> cluster -> for each
 * bug, fetch candidate issues and ask Claude whether it matches an existing
 * issue. Prints decisions + token cost. Spends Anthropic tokens; only reads
 * GitHub.
 *
 * Window/model: ARGUS_SMOKE_SINCE_HOURS=72 ARGUS_MODEL=claude-opus-4-8 ...
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { fetchNewMessages } from '../src/discord/ingest.js';
import { clusterMessages } from '../src/claude/cluster.js';
import { judgeMatch } from '../src/claude/merge.js';
import { findCandidateIssues } from '../src/github/sync.js';
import { resetUsage, usageSummary } from '../src/claude/usage.js';
import type { Config } from '../src/config.js';

const DISCORD_EPOCH = 1420070400000n;

const discordToken = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const apiKey = process.env.ANTHROPIC_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const repoSlug = process.env.GITHUB_REPO;
if (!discordToken || !channelId || !apiKey || !githubToken || !repoSlug) {
  console.error('Need DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO');
  process.exit(1);
}
const [owner, repo] = repoSlug.split('/') as [string, string];

const model = process.env.ARGUS_MODEL ?? 'claude-opus-4-8';
const hours = Number(process.env.ARGUS_SMOKE_SINCE_HOURS ?? '72');
const maxMessages = Number(process.env.ARGUS_MAX_MESSAGES ?? '500');
const sinceMs = BigInt(Date.now() - hours * 3600 * 1000);
const cursor = ((sinceMs - DISCORD_EPOCH) << 22n).toString();

const rest = new REST({ version: '10' }).setToken(discordToken);
const client = new Anthropic({ apiKey });
const octokit = new Octokit({ auth: githubToken });
const config = {
  discord: { sourceChannelId: channelId },
  anthropic: { apiKey, model },
  github: { token: githubToken, owner, repo },
  behavior: { maxMessages },
} as unknown as Config;

resetUsage();
console.log(`Last ${hours}h -> cluster -> match against ${owner}/${repo} (no writes)\n`);

const ingest = await fetchNewMessages(rest, config, { lastMessageId: cursor });
console.log(`ingested ${ingest.messages.length} message(s)`);

const bugs = await clusterMessages(client, config, ingest.messages);
console.log(`clustered ${bugs.length} bug(s)\n`);

for (const [i, bug] of bugs.entries()) {
  const candidates = await findCandidateIssues(octokit, config, bug);
  const decision = await judgeMatch(client, config, bug, candidates);
  console.log(`#${i + 1} [${bug.severity}] ${bug.title}`);
  console.log(`     candidates considered: ${candidates.length}`);
  if (decision.issueNumber === null) {
    console.log('     -> NEW issue would be created');
  } else {
    console.log(`     -> MERGE into #${decision.issueNumber}`);
    console.log(`        new info: ${decision.newInformation || '(none — nothing to add)'}`);
  }
  console.log('');
}

console.log('token usage:', usageSummary());
