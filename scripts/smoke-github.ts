/**
 * GitHub sync smoke test — not part of the build (outside src/).
 *
 * Read-only by default (lists candidate issues):
 *   npx tsx scripts/smoke-github.ts
 *
 * Actually create + merge a throwaway test issue (WRITES to the repo):
 *   npx tsx scripts/smoke-github.ts --write
 *
 * The test issue is clearly labelled "[Argus test]" — delete it when done.
 * Point GITHUB_REPO at a scratch repo for this unless you're confident.
 */
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { createIssue, findCandidateIssues, mergeIntoIssue } from '../src/github/sync.js';
import type { Config } from '../src/config.js';
import type { BugReport } from '../src/types.js';

const token = process.env.GITHUB_TOKEN;
const repoSlug = process.env.GITHUB_REPO;
if (!token || !repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
  console.error('Need GITHUB_TOKEN and GITHUB_REPO ("owner/repo")');
  process.exit(1);
}
const [owner, repo] = repoSlug.split('/') as [string, string];
const write = process.argv.includes('--write');

const octokit = new Octokit({ auth: token });
const config = { github: { token, owner, repo } } as unknown as Config;

const bug: BugReport = {
  title: '[Argus test] Sample bug — safe to delete',
  summary: 'A throwaway issue created by the Argus phase-4 smoke test.',
  description: 'This is a **test** issue created by Argus to verify GitHub sync. Safe to close or delete.',
  stepsToReproduce: ['Run the smoke test', 'Observe this issue'],
  severity: 'low',
  area: 'test',
  sourceMessageIds: ['smoke-msg-1', 'smoke-msg-2'],
  reporters: ['000000000000000000'],
};

console.log(`Target: ${owner}/${repo}  (write=${write})\n`);

const candidates = await findCandidateIssues(octokit, config, bug);
console.log(`candidate issues found: ${candidates.length}`);
for (const c of candidates.slice(0, 5)) console.log(`  #${c.number} ${c.title}`);

if (!write) {
  console.log('\nRead-only run. Re-run with --write to create a test issue.');
  process.exit(0);
}

const issue = await createIssue(octokit, config, bug);
console.log(`\ncreated: ${issue.url}`);

const merged = await mergeIntoIssue(octokit, config, bug, {
  issueNumber: issue.number,
  newInformation: 'A follow-up report added more detail: also happens on the second playthrough.',
});
console.log(`merged (comment + fingerprint update): ${merged.url}`);
console.log('\nDone. Delete the test issue when finished.');
