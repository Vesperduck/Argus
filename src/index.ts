import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createDiscordRest } from './discord/client.js';
import { createAnthropic } from './claude/client.js';
import { createOctokit } from './github/client.js';
import { fetchNewMessages } from './discord/ingest.js';
import {
  postProposal,
  postProposalsHeader,
  postRunSummary,
  ProposalMessageGoneError,
  readProposalReactions,
  updateProposalMessage,
  type ReactionVerdict,
} from './discord/report.js';
import { clusterMessages } from './claude/cluster.js';
import { judgeMatch } from './claude/merge.js';
import {
  createIssue,
  findCandidateIssues,
  findIssueCoveringSources,
  mergeIntoIssue,
} from './github/sync.js';
import { loadState, saveState } from './state/store.js';
import { resetUsage, usageSummary } from './claude/usage.js';
import type { Config } from './config.js';
import type { BugReport, IssueRef, Proposal, ProposalAction, SyncOutcome } from './types.js';

/** True if any open proposal already covers one of this bug's source messages. */
function overlapsPending(pending: Proposal[], bug: BugReport): boolean {
  const ids = new Set(bug.sourceMessageIds);
  return pending.some((p) => p.bug.sourceMessageIds.some((id) => ids.has(id)));
}

/** Is this user allowed to approve/reject the given proposal? */
function isAuthorized(userId: string, proposal: Proposal, config: Config): boolean {
  const a = config.behavior.approvers;
  if (a === 'anyone') return true;
  if (a === 'reporters') return proposal.bug.reporters.includes(userId);
  return a.userIds.includes(userId);
}

type Resolution = 'approved' | 'rejected' | 'expired' | 'pending';

function resolveProposal(
  verdict: ReactionVerdict,
  proposal: Proposal,
  config: Config,
  nowMs: number,
): Resolution {
  if (verdict.rejectedBy.some((id) => isAuthorized(id, proposal, config))) return 'rejected';
  if (verdict.approvedBy.some((id) => isAuthorized(id, proposal, config))) return 'approved';
  const ageHours = (nowMs - Date.parse(proposal.proposedAt)) / 3_600_000;
  if (ageHours > config.behavior.proposalTtlHours) return 'expired';
  return 'pending';
}

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  logger.info('Argus starting', {
    dryRun: args.dryRun,
    repo: `${config.github.owner}/${config.github.repo}`,
    model: config.anthropic.model,
    requireApproval: config.behavior.requireApproval,
  });

  const discord = createDiscordRest(config);
  const anthropic = createAnthropic(config);
  const github = createOctokit(config);

  resetUsage();
  const state = await loadState(github, config);
  const outcomes: SyncOutcome[] = [];

  // --- Phase A: resolve pending proposals ---------------------------------
  // Read reactions, apply approver policy + TTL, execute approved actions.
  const stillPending: Proposal[] = [];
  for (const proposal of state.pendingProposals) {
    try {
      const { verdict, channelId } = await readProposalReactions(discord, config, proposal);
      proposal.channelId = channelId; // backfill / correct the stored channel
      const status = resolveProposal(verdict, proposal, config, Date.now());
      logger.debug('resolve proposal', { id: proposal.id, status, channelId, verdict });

      if (status === 'pending') {
        stillPending.push(proposal);
        continue;
      }
      if (args.dryRun) {
        logger.info(`[dry-run] proposal ${proposal.id} would be ${status}`);
        stillPending.push(proposal); // don't mutate state in dry-run
        continue;
      }

      if (status === 'approved') {
        // Idempotency guard: if an Argus issue already covers these source
        // messages, don't file again (protects against stale state / re-runs).
        const covered = await findIssueCoveringSources(github, config, proposal.bug);
        if (covered) {
          logger.info(`proposal ${proposal.id} already filed (#${covered.number}) — skipping`);
          await updateProposalMessage(discord, config, proposal, `✅ Already filed: ${covered.url}`);
          outcomes.push({
            action: 'skipped',
            reason: `already filed (#${covered.number})`,
            bug: proposal.bug,
          });
          continue;
        }

        let issue: IssueRef;
        let act: 'created' | 'updated';
        if (proposal.action.kind === 'create') {
          issue = await createIssue(github, config, proposal.bug);
          act = 'created';
        } else {
          issue = await mergeIntoIssue(github, config, proposal.bug, {
            issueNumber: proposal.action.issueNumber,
            newInformation: proposal.action.newInformation,
          });
          act = 'updated';
        }
        await updateProposalMessage(discord, config, proposal, `✅ Filed: ${issue.url}`);
        outcomes.push({ action: act, issue, bug: proposal.bug });
      } else if (status === 'rejected') {
        await updateProposalMessage(discord, config, proposal, '❌ Dismissed.');
        outcomes.push({ action: 'skipped', reason: 'rejected', bug: proposal.bug });
      } else {
        await updateProposalMessage(discord, config, proposal, '⌛ Expired — no response.');
        outcomes.push({ action: 'skipped', reason: 'expired', bug: proposal.bug });
      }
    } catch (err) {
      if (err instanceof ProposalMessageGoneError) {
        // The message was deleted (or is unreachable) — drop it rather than
        // retrying forever, which would also block the cursor indefinitely.
        logger.warn(`dropping proposal ${proposal.id}: ${err.message}`);
        outcomes.push({ action: 'skipped', reason: 'message gone', bug: proposal.bug });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`failed resolving proposal ${proposal.id}`, message);
      outcomes.push({ action: 'failed', error: message, bug: proposal.bug });
      stillPending.push(proposal); // keep it to retry next run
    }
  }
  state.pendingProposals = stillPending;

  // --- Phase B: ingest + cluster ------------------------------------------
  const ingest = await fetchNewMessages(discord, config, state.cursor);
  logger.info(`fetched ${ingest.messages.length} new message(s)`);
  logger.debug(
    'ingested',
    ingest.messages.map((m) => ({
      id: m.id,
      author: m.authorName,
      thread: m.threadId ?? null,
      at: m.createdAt,
      preview: m.content.slice(0, 80),
    })),
  );

  if (ingest.messages.length > 0) {
    const bugs = await clusterMessages(anthropic, config, ingest.messages);
    logger.info(`clustered into ${bugs.length} bug(s)`);

    // --- Phase C: per-bug decision ----------------------------------------
    // Post the review header once, lazily, before the first proposal.
    let headerPosted = false;
    for (const bug of bugs) {
      try {
        // Dedup: skip bugs already covered by an open proposal or a filed issue.
        if (overlapsPending(state.pendingProposals, bug)) {
          logger.info(`skipping already-proposed bug: ${bug.title}`);
          outcomes.push({ action: 'skipped', reason: 'already proposed', bug });
          continue;
        }
        const covered = await findIssueCoveringSources(github, config, bug);
        if (covered) {
          logger.info(`skipping already-filed bug (#${covered.number}): ${bug.title}`);
          outcomes.push({ action: 'skipped', reason: `already filed (#${covered.number})`, bug });
          continue;
        }

        const candidates = await findCandidateIssues(github, config, bug);
        const decision = await judgeMatch(anthropic, config, bug, candidates);
        const wantsMerge = decision.issueNumber !== null;
        const action: ProposalAction = wantsMerge
          ? {
              kind: 'merge',
              issueNumber: decision.issueNumber as number,
              newInformation: decision.newInformation,
            }
          : { kind: 'create' };

        if (config.behavior.requireApproval) {
          if (args.dryRun) {
            logger.info(`[dry-run] would propose: ${bug.title}`);
            outcomes.push({ action: 'skipped', reason: 'dry-run', bug });
            continue;
          }
          if (!headerPosted) {
            await postProposalsHeader(discord, config);
            headerPosted = true;
          }
          const { discordMessageId, channelId } = await postProposal(discord, config, bug, action);
          const proposal: Proposal = {
            id: randomUUID(),
            discordMessageId,
            channelId,
            bug,
            action,
            state: 'pending',
            proposedAt: new Date().toISOString(),
          };
          state.pendingProposals.push(proposal);
          outcomes.push({ action: 'proposed', proposal });
        } else {
          if (args.dryRun) {
            logger.info(`[dry-run] would ${wantsMerge ? 'update' : 'create'} issue: ${bug.title}`);
            outcomes.push({ action: 'skipped', reason: 'dry-run', bug });
            continue;
          }
          const issue = wantsMerge
            ? await mergeIntoIssue(github, config, bug, decision)
            : await createIssue(github, config, bug);
          outcomes.push({ action: wantsMerge ? 'updated' : 'created', issue, bug });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`failed handling bug "${bug.title}"`, message);
        outcomes.push({ action: 'failed', error: message, bug });
      }
    }
  } else {
    logger.info('no new messages this run');
  }

  // --- Finish: report + advance cursor ------------------------------------
  await emitSummary();

  const allHandled = !outcomes.some((o) => o.action === 'failed');
  if (allHandled && ingest.newCursor) {
    state.cursor = { lastMessageId: ingest.newCursor, lastRunAt: new Date().toISOString() };
  } else if (!allHandled) {
    logger.warn('not advancing cursor (failures present)');
  }

  await persist();
  logger.info('token usage', usageSummary());
  logger.info('Argus done', { outcomes: outcomes.map((o) => o.action) });

  async function emitSummary(): Promise<void> {
    if (config.behavior.silentWhenEmpty && outcomes.length === 0) return;
    if (args.dryRun) {
      logger.info('[dry-run] would post run summary', { outcomes: outcomes.map((o) => o.action) });
      return;
    }
    await postRunSummary(discord, config, outcomes);
  }

  async function persist(): Promise<void> {
    if (args.dryRun) {
      logger.info('[dry-run] state not persisted');
      return;
    }
    await saveState(github, config, state);
  }
}

main().catch((err) => {
  logger.error('fatal', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
