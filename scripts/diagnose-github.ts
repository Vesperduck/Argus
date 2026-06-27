/**
 * Standalone GitHub access diagnostic — not part of the build (outside src/).
 * Run: npx tsx scripts/diagnose-github.ts
 *
 * Verifies the configured token can do what Argus's GitHub sync needs:
 * authenticate, see the repo, read issues, search issues, and (inferred from
 * repo permissions) write issues. Does NOT create any issues.
 */
import 'dotenv/config';
import { Octokit } from '@octokit/rest';

const token = process.env.GITHUB_TOKEN;
const repoSlug = process.env.ARGUS_GITHUB_REPO ?? process.env.GITHUB_REPO;
if (!token || !repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
  console.error('Need GITHUB_TOKEN and ARGUS_GITHUB_REPO (or GITHUB_REPO) as "owner/repo"');
  process.exit(1);
}
const [owner, repo] = repoSlug.split('/') as [string, string];

const octokit = new Octokit({ auth: token });

function describe(err: unknown): string {
  const e = err as { status?: number; message?: string };
  return `status=${e.status ?? '?'} ${e.message ?? String(err)}`;
}

let anyFailure = false;

// 1) Token identity (best-effort — some token types have no user)
try {
  const me = await octokit.rest.users.getAuthenticated();
  console.log(`[ok] token identity: ${me.data.login} (${me.data.type})`);
} catch (err) {
  console.log(`[info] no user identity for this token (normal for app/deploy tokens): ${describe(err)}`);
}

// 2) Repo visibility + permission flags
let canWrite = false;
try {
  const r = await octokit.rest.repos.get({ owner, repo });
  const p = r.data.permissions ?? {};
  canWrite = Boolean(p.push || p.maintain || p.admin || p.triage);
  console.log(
    `[ok] repo visible: ${r.data.full_name} (private=${r.data.private}) permissions=${JSON.stringify(p)}`,
  );
} catch (err) {
  anyFailure = true;
  console.error(`[fail] cannot access repo ${repoSlug}: ${describe(err)}`);
  console.error('      → the token cannot see this repo (wrong repo, or no access).');
}

// 3) Issue read
try {
  const issues = await octokit.rest.issues.listForRepo({ owner, repo, state: 'all', per_page: 1 });
  console.log(`[ok] can read issues (sample count: ${issues.data.length})`);
} catch (err) {
  anyFailure = true;
  console.error(`[fail] cannot read issues: ${describe(err)}`);
}

// 4) Issue search (used for duplicate candidate retrieval)
try {
  const found = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue`,
    per_page: 1,
  });
  console.log(`[ok] can search issues (total matched: ${found.data.total_count})`);
} catch (err) {
  anyFailure = true;
  console.error(`[fail] cannot search issues: ${describe(err)}`);
  console.error('      → the search:issues scope/permission may be missing.');
}

// 5) Contents read (state file storage)
try {
  await octokit.rest.repos.getContent({ owner, repo, path: '' });
  console.log('[ok] can read repo contents (state file storage)');
} catch (err) {
  if ((err as { status?: number }).status === 404) {
    console.log('[ok] repo contents reachable (empty repo)');
  } else {
    anyFailure = true;
    console.error(`[fail] cannot read repo contents: ${describe(err)}`);
    console.error('      → grant the token "Contents: read & write" (fine-grained) or `repo` (classic).');
  }
}

// 6) Write capability (inferred — no issue is created)
if (canWrite) {
  console.log('[ok] token has write-level repo permission → issue create/comment should work');
} else {
  anyFailure = true;
  console.error(
    '[warn] token lacks write-level permission (push/triage/maintain/admin) → creating or ' +
      'commenting on issues will fail. A deploy key / read-only token cannot file issues.',
  );
}

console.log(anyFailure ? '\nSome checks failed — see above.' : '\nAll checks passed.');
process.exit(anyFailure ? 1 : 0);
