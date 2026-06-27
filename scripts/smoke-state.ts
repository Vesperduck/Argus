/**
 * State persistence smoke test — not part of the build (outside src/).
 *
 * Read-only (loads + prints current state):
 *   npx tsx scripts/smoke-state.ts
 *
 * Round-trip (WRITES — commits the state file back to the repo):
 *   npx tsx scripts/smoke-state.ts --write
 *
 * Verifies the token has Contents read (and, with --write, Contents write).
 */
import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import { loadState, saveState } from '../src/state/store.js';
import type { Config } from '../src/config.js';

const token = process.env.GITHUB_TOKEN;
const repoSlug = process.env.GITHUB_REPO;
if (!token || !repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
  console.error('Need GITHUB_TOKEN and GITHUB_REPO ("owner/repo")');
  process.exit(1);
}
const [owner, repo] = repoSlug.split('/') as [string, string];
const write = process.argv.includes('--write');

const octokit = new Octokit({ auth: token });
const config = {
  github: { token, owner, repo },
  state: {
    path: process.env.ARGUS_STATE_PATH ?? '.argus/state.json',
    branch: process.env.ARGUS_STATE_BRANCH,
  },
} as unknown as Config;

console.log(`State file: ${owner}/${repo}:${config.state.path} (write=${write})\n`);

try {
  const state = await loadState(octokit, config);
  console.log('cursor:', state.cursor);
  console.log('pending proposals:', state.pendingProposals.length);

  if (write) {
    await saveState(octokit, config, state);
    console.log('\nwrote state back (a commit was created). Round-trip OK.');
  } else {
    console.log('\nRead-only run. Re-run with --write to test the commit round-trip.');
  }
} catch (err) {
  console.error(`\n[fail] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
