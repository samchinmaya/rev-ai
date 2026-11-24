const test = require('node:test');
const assert = require('node:assert');
const { classifyGit, classifyGh } = require('../src/risk');

const g = (s) => classifyGit(s.split(' ')).level;
const h = (s) => classifyGh(s.split(' ')).level;

test('safe git commands run without asking', () => {
  for (const c of ['status', 'pull', 'fetch --all', 'add -A', 'commit -m x', 'push origin feature/x', 'push -u origin HEAD',
    'checkout -b feat', 'switch main', 'branch', 'log --oneline -n 5', 'stash', 'stash pop', 'rebase --continue', 'restore --staged a.js', 'merge main']) {
    assert.strictEqual(g(c), 'safe', c);
  }
});

test('destructive git commands are flagged as danger', () => {
  for (const c of ['push --force', 'push -f origin x', 'push --force-with-lease', 'push origin +main', 'push origin --delete x',
    'push origin :x', 'rebase main', 'reset --hard HEAD~1', 'clean -fd', 'branch -D x', 'checkout -- .', 'restore a.js',
    'stash drop', 'filter-branch', 'switch -f main']) {
    assert.strictEqual(g(c), 'danger', c);
  }
});

test('moderate git commands ask for confirmation', () => {
  for (const c of ['push origin main', 'commit --amend', 'branch -d x', 'reset HEAD~1', 'tag -d v1']) {
    assert.strictEqual(g(c), 'confirm', c);
  }
});

test('interactive git is blocked', () => {
  assert.strictEqual(g('rebase -i main'), 'blocked');
  assert.strictEqual(g('add -i'), 'blocked');
});

test('gh classification', () => {
  for (const c of ['pr list', 'pr view 3', 'pr checks 3', 'pr diff 3', 'api repos/a/b/pulls', 'run list', 'auth status']) assert.strictEqual(h(c), 'safe', c);
  for (const c of ['pr create --title x', 'pr comment 3 --body y', 'pr review 3 --approve', 'api -X POST repos/a/b/issues']) assert.strictEqual(h(c), 'confirm', c);
  for (const c of ['pr merge 3 --squash', 'pr close 3', 'repo delete a/b', 'api -X DELETE repos/a/b']) assert.strictEqual(h(c), 'danger', c);
  for (const c of ['auth token', 'auth logout', 'secret set X']) assert.strictEqual(h(c), 'blocked', c);
});
