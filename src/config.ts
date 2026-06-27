import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is read as raw strings and validated/coerced into a typed Config.
 * Keeping the coercion explicit (rather than via zod transforms) avoids the
 * footgun where `z.coerce.boolean()` treats the string "false" as `true`.
 */
const EnvSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  // Source = channel to analyse; review = channel to post proposals/summaries to.
  // DISCORD_CHANNEL_ID is a backward-compatible alias for the source channel.
  DISCORD_CHANNEL_ID: z.string().optional(),
  DISCORD_SOURCE_CHANNEL_ID: z.string().optional(),
  DISCORD_REVIEW_CHANNEL_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  GITHUB_REPO: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, 'GITHUB_REPO must be in "owner/repo" form'),
  ARGUS_STATE_PATH: z.string().optional(),
  ARGUS_STATE_BRANCH: z.string().optional(),
  ARGUS_MODEL: z.string().optional(),
  ARGUS_MAX_MESSAGES: z.string().optional(),
  ARGUS_REQUIRE_APPROVAL: z.string().optional(),
  ARGUS_APPROVERS: z.string().optional(),
  ARGUS_PROPOSAL_TTL_HOURS: z.string().optional(),
  ARGUS_SILENT_WHEN_EMPTY: z.string().optional(),
});

export type Approvers = 'reporters' | 'anyone' | { userIds: string[] };

export interface Config {
  discord: { token: string; sourceChannelId: string; reviewChannelId: string };
  anthropic: { apiKey: string; model: string };
  github: { token: string; owner: string; repo: string };
  state: { path: string; branch?: string };
  behavior: {
    maxMessages: number;
    requireApproval: boolean;
    approvers: Approvers;
    proposalTtlHours: number;
    silentWhenEmpty: boolean;
  };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`Expected a boolean, got "${value}"`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Expected a positive integer, got "${value}"`);
  return n;
}

function parseApprovers(value: string | undefined): Approvers {
  const v = (value ?? 'reporters').trim();
  if (v === 'reporters' || v === 'anyone') return v;
  const userIds = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (userIds.length === 0) return 'reporters';
  return { userIds };
}

export function loadConfig(): Config {
  const env = EnvSchema.parse(process.env);
  const [owner, repo] = env.GITHUB_REPO.split('/') as [string, string];

  const sourceChannelId = env.DISCORD_SOURCE_CHANNEL_ID ?? env.DISCORD_CHANNEL_ID;
  if (!sourceChannelId) {
    throw new Error('DISCORD_SOURCE_CHANNEL_ID (or DISCORD_CHANNEL_ID) is required');
  }
  const reviewChannelId = env.DISCORD_REVIEW_CHANNEL_ID ?? sourceChannelId;

  return {
    discord: { token: env.DISCORD_BOT_TOKEN, sourceChannelId, reviewChannelId },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ARGUS_MODEL ?? 'claude-opus-4-8' },
    github: { token: env.GITHUB_TOKEN, owner, repo },
    state: {
      path: env.ARGUS_STATE_PATH ?? '.argus/state.json',
      branch: env.ARGUS_STATE_BRANCH,
    },
    behavior: {
      maxMessages: parsePositiveInt(env.ARGUS_MAX_MESSAGES, 500),
      requireApproval: parseBool(env.ARGUS_REQUIRE_APPROVAL, true),
      approvers: parseApprovers(env.ARGUS_APPROVERS),
      proposalTtlHours: parsePositiveInt(env.ARGUS_PROPOSAL_TTL_HOURS, 72),
      silentWhenEmpty: parseBool(env.ARGUS_SILENT_WHEN_EMPTY, false),
    },
  };
}
