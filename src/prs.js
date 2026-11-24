// PR manager: reads and acts on pull requests through the gh CLI.
const { run } = require('./exec');

const REPO_FIELDS = 'number,title,url,headRefName,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,mergeable,updatedAt';
const SEARCH_FIELDS = 'number,title,url,repository,isDraft,updatedAt,author';

function summarizeChecks(rollup) {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const c of rollup || []) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) out.pass++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) out.fail++;
    else out.pending++;
  }
  out.total = out.pass + out.fail + out.pending;
  out.state = out.total === 0 ? 'none' : out.fail ? 'fail' : out.pending ? 'pending' : 'pass';
  return out;
}

function parse(res) {
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'gh failed').trim());
  return JSON.parse(res.stdout || '[]');
}

/**
 * Can the signed-in user merge PRs in this repo? Needs write ("push"), maintain or admin access.
 * Anything we can't confirm counts as no, so the Merge button stays hidden.
 */
async function canMergeIn(repo, dir) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return false;
  const r = await run('gh', ['api', `repos/${repo}`, '--jq', '.permissions'], dir);
  if (r.code !== 0) return false;
  try {
    const p = JSON.parse(r.stdout || '{}') || {};
    return Boolean(p.admin || p.maintain || p.push);
  } catch {
    return false;
  }
}

async function load(cwd) {
  const dir = cwd || process.env.HOME;
  const result = { repo: [], mine: [], review: [], errors: [] };

  const auth = await run('gh', ['auth', 'status'], dir);
  if (auth.code !== 0) {
    result.errors.push(
      /not installed/.test(auth.stderr)
        ? 'GitHub CLI (gh) is not installed. Run: brew install gh'
        : 'GitHub CLI is not signed in. Run: gh auth login',
    );
    return result;
  }

  const jobs = [
    cwd
      ? run('gh', ['pr', 'list', '--state', 'open', '--limit', '30', '--json', REPO_FIELDS], cwd).then((r) => {
          result.repo = parse(r).map((p) => ({ ...p, checks: summarizeChecks(p.statusCheckRollup), statusCheckRollup: undefined }));
          return run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd).then((v) => {
            const name = v.stdout.trim();
            result.repo.forEach((p) => (p.repository = { nameWithOwner: name }));
          });
        })
      : Promise.resolve(),
    run('gh', ['search', 'prs', '--author=@me', '--state=open', '--limit', '30', '--json', SEARCH_FIELDS], dir).then((r) => {
      result.mine = parse(r);
    }),
    run('gh', ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '30', '--json', SEARCH_FIELDS], dir).then((r) => {
      result.review = parse(r);
    }),
  ];
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) if (s.status === 'rejected') result.errors.push(s.reason.message);

  // Look up merge rights once per repository and mark every PR with it.
  const all = [...result.repo, ...result.mine, ...result.review];
  const repos = [...new Set(all.map((p) => p.repository?.nameWithOwner).filter(Boolean))];
  const rights = new Map(await Promise.all(repos.map(async (r) => [r, await canMergeIn(r, dir)])));
  for (const p of all) p.canMerge = rights.get(p.repository?.nameWithOwner) === true;
  return result;
}

function checkout(cwd, number) {
  if (!cwd) return { code: 1, stderr: 'Pick a repository first.' };
  return run('gh', ['pr', 'checkout', String(Number(number))], cwd);
}

async function merge(cwd, { repo, number, method, deleteBranch }) {
  const dir = cwd || process.env.HOME;
  if (repo && !(await canMergeIn(repo, dir))) {
    return { code: 1, stderr: `You don't have permission to merge pull requests in ${repo}.` };
  }
  const flag = { squash: '--squash', rebase: '--rebase', merge: '--merge' }[method] || '--squash';
  const args = ['pr', 'merge', String(Number(number)), flag];
  if (repo) args.push('-R', repo);
  if (deleteBranch) args.push('--delete-branch');
  return run('gh', args, dir);
}

function create(cwd, { title, body, base, draft }) {
  if (!cwd) return { code: 1, stderr: 'Pick a repository first.' };
  if (!title) return { code: 1, stderr: 'A title is required.' };
  const args = ['pr', 'create', '--title', String(title), '--body', String(body || '')];
  if (base) args.push('--base', String(base));
  if (draft) args.push('--draft');
  return run('gh', args, cwd);
}

module.exports = { load, checkout, merge, create, summarizeChecks, canMergeIn };
