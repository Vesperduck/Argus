import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is read as raw strings and validated/coerced into a typed Config.
 * Keeping the coercion explicit (rather than via zod transforms) avoids the
 * footgun where `z.coerce.boolean()` treats the string "false" as `true`.
 */
// Treat blank/whitespace-only values as absent. GitHub Actions passes unset
// `vars`/`secrets` as empty strings (not undefined), and blank .env lines behave
// the same — both should fall back to defaults rather than become "".
const blankToUndef = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const required = (msg: string) =>
  z.preprocess(blankToUndef, z.string({ required_error: msg, invalid_type_error: msg }).min(1, msg));
const optional = z.preprocess(blankToUndef, z.string().optional());

const EnvSchema = z.object({
  DISCORD_BOT_TOKEN: required('DISCORD_BOT_TOKEN is required'),
  // Source = channel to analyse; review = channel to post proposals/summaries to.
  // DISCORD_CHANNEL_ID is a backward-compatible alias for the source channel.
  DISCORD_CHANNEL_ID: optional,
  DISCORD_SOURCE_CHANNEL_ID: optional,
  DISCORD_REVIEW_CHANNEL_ID: optional,
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY is required'),
  GITHUB_TOKEN: required('GITHUB_TOKEN is required'),
  GITHUB_REPO: z.preprocess(
    blankToUndef,
    z
      .string({ required_error: 'GITHUB_REPO is required' })
      .regex(/^[^/\s]+\/[^/\s]+$/, 'GITHUB_REPO must be in "owner/repo" form'),
  ),
  ARGUS_STATE_PATH: optional,
  ARGUS_STATE_BRANCH: optional,
  ARGUS_MODEL: optional,
  ARGUS_MAX_MESSAGES: optional,
  ARGUS_REQUIRE_APPROVAL: optional,
  ARGUS_APPROVERS: optional,
  ARGUS_PROPOSAL_TTL_HOURS: optional,
  ARGUS_SILENT_WHEN_EMPTY: optional,
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
