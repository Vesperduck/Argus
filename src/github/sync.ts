import type { Octokit } from '@octokit/rest';
import type { Config } from '../config.js';
import type { BugReport, IssueRef, MatchDecision } from '../types.js';
import type { CandidateIssue } from '../claude/merge.js';
import { logger } from '../logger.js';

/** How many recent open issues to consider as duplicate candidates. */
const CANDIDATE_LIMIT = 30;
/** Body excerpt length handed to the matcher, to bound tokens. */
const CANDIDATE_BODY_CHARS = 4000;

const ARGUS_LABEL = 'argus';
const FINGERPRINT_RE = /<!--\s*argus:v1\s+sources=([^>]*?)\s*-->/;

// ---------------------------------------------------------------------------
// Fingerprint marker (idempotency) + issue body rendering
// ---------------------------------------------------------------------------

function buildFingerprint(sourceIds: string[]): string {
  const unique = [...new Set(sourceIds)].sort();
  return `<!-- argus:v1 sources=${unique.join(',')} -->`;
}

/** Extract the source message IDs already folded into an issue body, if any. */
export function parseFingerprint(body: string | null | undefined): string[] {
  if (!body) return [];
  const m = FINGERPRINT_RE.exec(body);
  if (!m || !m[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderIssueBody(bug: BugReport): string {
  const parts: string[] = [];
  parts.push(bug.summary.trim());
  parts.push('');
  parts.push('## Details');
  parts.push(bug.description.trim());

  if (bug.stepsToReproduce?.length) {
    parts.push('');
    parts.push('## Steps to reproduce');
    parts.push(...bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`));
  }

  parts.push('');
  parts.push(`**Severity:** ${bug.severity}`);
  if (bug.area) parts.push(`**Area:** ${bug.area}`);
  if (bug.reporters.length) {
    parts.push(`**Reported by (Discord user IDs):** ${bug.reporters.join(', ')}`);
  }

  parts.push('');
  parts.push('---');
  parts.push('<sub>Filed by Argus from Discord bug reports.</sub>');
  parts.push(buildFingerprint(bug.sourceMessageIds));

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const LABEL_COLORS: Record<string, string> = {
  argus: '5319e7',
  'severity:low': 'c2e0c6',
  'severity:medium': 'fbca04',
  'severity:high': 'd93f0b',
  'severity:critical': 'b60205',
  'severity:unknown': 'ededed',
};

function labelsFor(bug: BugReport): string[] {
  return [ARGUS_LABEL, `severity:${bug.severity}`];
}

async function ensureLabels(octokit: Octokit, config: Config, labels: string[]): Promise<void> {
  const { owner, repo } = config.github;
  for (const name of labels) {
    try {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color: LABEL_COLORS[name] ?? 'ededed',
      });
    } catch (err) {
      // 422 => label already exists; anything else is a real failure.
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate retrieval
// ---------------------------------------------------------------------------

/**
 * Shortlist possibly-duplicate issues: all `argus`-labelled issues plus the most
 * recently updated open issues (to also catch human-filed duplicates). Pull
 * requests are excluded. The Claude matcher (phase 5) makes the final call.
 */
export async function findCandidateIssues(
  octokit: Octokit,
  config: Config,
  _bug: BugReport,
): Promise<CandidateIssue[]> {
  const { owner, repo } = config.github;
  const byNumber = new Map<number, CandidateIssue>();

  const add = (issue: {
    number: number;
    title: string;
    body?: string | null;
    pull_request?: unknown;
  }): void => {
    if (issue.pull_request) return; // skip PRs
    if (byNumber.has(issue.number)) return;
    byNumber.set(issue.number, {
      number: issue.number,
      title: issue.title,
      body: (issue.body ?? '').slice(0, CANDIDATE_BODY_CHARS),
    });
  };

  const argusIssues = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: ARGUS_LABEL,
    state: 'all',
    per_page: 100,
  });
  for (const issue of argusIssues.data) add(issue);

  const recentOpen = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: CANDIDATE_LIMIT,
  });
  for (const issue of recentOpen.data) add(issue);

  return [...byNumber.values()];
}

/**
 * Fingerprint-based idempotency check: is there already an Argus issue that has
 * folded in every one of this bug's source messages? If so, there's nothing new.
 */
export async function findIssueCoveringSources(
  octokit: Octokit,
  config: Config,
  bug: BugReport,
): Promise<IssueRef | null> {
  const { owner, repo } = config.github;
  const argusIssues = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: ARGUS_LABEL,
    state: 'all',
    per_page: 100,
  });
  const wanted = new Set(bug.sourceMessageIds);
  for (const issue of argusIssues.data) {
    if (issue.pull_request) continue;
    const have = new Set(parseFingerprint(issue.body));
    if ([...wanted].every((id) => have.has(id))) {
      return { number: issue.number, url: issue.html_url };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Create / merge
// ---------------------------------------------------------------------------

export async function createIssue(
  octokit: Octokit,
  config: Config,
  bug: BugReport,
): Promise<IssueRef> {
  const { owner, repo } = config.github;
  const labels = labelsFor(bug);
  await ensureLabels(octokit, config, labels);

  const res = await octokit.rest.issues.create({
    owner,
    repo,
    title: bug.title,
    body: renderIssueBody(bug),
    labels,
  });
  logger.info(`created issue #${res.data.number}`, { title: bug.title });
  return { number: res.data.number, url: res.data.html_url };
}

/**
 * Merge new information into an existing issue: append a comment with the delta,
 * and update the fingerprint marker so future runs know these sources are folded
 * in. Editing the body is limited to the marker line — the prose is preserved.
 */
export async function mergeIntoIssue(
  octokit: Octokit,
  config: Config,
  bug: BugReport,
  decision: MatchDecision,
): Promise<IssueRef> {
  const { owner, repo } = config.github;
  const issueNumber = decision.issueNumber;
  if (issueNumber === null) {
    throw new Error('mergeIntoIssue called with a null issueNumber');
  }

  const existing = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const body = existing.data.body ?? '';

  const mergedSources = [...parseFingerprint(body), ...bug.sourceMessageIds];
  const marker = buildFingerprint(mergedSources);
  const newBody = FINGERPRINT_RE.test(body)
    ? body.replace(FINGERPRINT_RE, marker)
    : `${body.trim()}\n\n${marker}`;

  await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, body: newBody });

  const note = decision.newInformation.trim();
  if (note.length > 0) {
    const reporters = bug.reporters.length
      ? `\n\n<sub>From Discord reporters: ${bug.reporters.join(', ')}</sub>`
      : '';
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `**Argus — new information from Discord:**\n\n${note}${reporters}`,
    });
  }

  logger.info(`merged into issue #${issueNumber}`, { title: bug.title, addedComment: note.length > 0 });
  return { number: issueNumber, url: existing.data.html_url };
}
