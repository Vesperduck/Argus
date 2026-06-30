import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ArgusState } from '../types.js';
import { BugReportSchema } from '../claude/schemas.js';
import { logger } from '../logger.js';

/**
 * State is persisted as a committed JSON file in the GitHub repo, read/written
 * via the Contents API (each save is a commit). The token needs Contents:
 * read & write in addition to Issues read & write.
 */

const ProposalActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }),
  z.object({
    kind: z.literal('merge'),
    issueNumber: z.number().int(),
    newInformation: z.string(),
  }),
]);

const ProposalSchema = z.object({
  id: z.string(),
  discordMessageId: z.string(),
  channelId: z.string().optional(),
  bug: BugReportSchema,
  action: ProposalActionSchema,
  state: z.enum(['pending', 'approved', 'rejected', 'expired']),
  proposedAt: z.string(),
});

const StateSchema = z.object({
  cursor: z.object({
    lastMessageId: z.string().optional(),
    lastRunAt: z.string().optional(),
  }),
  pendingProposals: z.array(ProposalSchema),
});

const EMPTY_STATE: ArgusState = { cursor: {}, pendingProposals: [] };

/** The blob sha of the last-read state file, needed to update it. */
let cachedSha: string | undefined;

function hasStatus(err: unknown, status: number): boolean {
  return (err as { status?: number } | null)?.status === status;
}

async function fetchSha(octokit: Octokit, config: Config): Promise<string | undefined> {
  const { owner, repo } = config.github;
  const { path, branch } = config.state;
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(branch ? { ref: branch } : {}),
    });
    const data = res.data;
    if (!Array.isArray(data) && data.type === 'file') return data.sha;
    return undefined;
  } catch (err) {
    if (hasStatus(err, 404)) return undefined;
    throw err;
  }
}

export async function loadState(octokit: Octokit, config: Config): Promise<ArgusState> {
  const { owner, repo } = config.github;
  const { path, branch } = config.state;

  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(branch ? { ref: branch } : {}),
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== 'file') {
      throw new Error(`state path "${path}" is not a file`);
    }
    cachedSha = data.sha;
    const json = Buffer.from(data.content, 'base64').toString('utf8');
    const parsed = StateSchema.parse(JSON.parse(json));
    logger.info('loaded state', {
      cursor: parsed.cursor.lastMessageId ?? '(none)',
      pending: parsed.pendingProposals.length,
    });
    return parsed;
  } catch (err) {
    if (hasStatus(err, 404)) {
      logger.info('no existing state file — starting fresh');
      cachedSha = undefined;
      return structuredClone(EMPTY_STATE);
    }
    if (hasStatus(err, 403)) {
      throw new Error(
        'GitHub token lacks Contents access (403). Grant it "Contents: read & write" ' +
          '(fine-grained PAT) or the `repo` scope (classic PAT) — Argus stores its state file ' +
          'in the repo.',
      );
    }
    // Corrupted/invalid state: fail loudly rather than silently resetting the
    // cursor and losing pending proposals.
    throw err;
  }
}

export async function saveState(
  octokit: Octokit,
  config: Config,
  state: ArgusState,
): Promise<void> {
  const { owner, repo } = config.github;
  const { path, branch } = config.state;
  const content = Buffer.from(JSON.stringify(state, null, 2), 'utf8').toString('base64');
  const message = `chore(argus): update state (${new Date().toISOString()})`;

  const put = (sha?: string) =>
    octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content,
      ...(sha ? { sha } : {}),
      ...(branch ? { branch } : {}),
    });

  try {
    const res = await put(cachedSha);
    cachedSha = res.data.content?.sha ?? undefined;
  } catch (err) {
    // 409 (sha conflict) or 422 (sha missing/stale): refetch and retry once.
    if (hasStatus(err, 409) || hasStatus(err, 422)) {
      const fresh = await fetchSha(octokit, config);
      const res = await put(fresh);
      cachedSha = res.data.content?.sha ?? undefined;
    } else {
      throw err;
    }
  }

  logger.info('saved state', { path, pending: state.pendingProposals.length });
}
