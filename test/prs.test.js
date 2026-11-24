// Checks that merge rights come from the repo's permissions, with a fake gh on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh2-'));
// repos/acme/mine -> push access; repos/acme/theirs -> read only; anything else fails.
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api repos/acme/mine") echo '{"admin":false,"maintain":false,"push":true,"pull":true}';;
  "api repos/acme/theirs") echo '{"admin":false,"maintain":false,"push":false,"pull":true}';;
  "pr merge") echo "merged $@" >> ${bin}/calls;;
  *) echo "nope" >&2; exit 1;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { canMergeIn, merge } = require('../src/prs');

test('merge rights follow repo permissions', async () => {
  assert.strictEqual(await canMergeIn('acme/mine', bin), true);
  assert.strictEqual(await canMergeIn('acme/theirs', bin), false);
  assert.strictEqual(await canMergeIn('acme/unknown', bin), false);
  assert.strictEqual(await canMergeIn('not a repo; rm -rf', bin), false);
});

test('merge refuses without permission and runs with it', async () => {
  const denied = await merge(bin, { repo: 'acme/theirs', number: 3, method: 'squash' });
  assert.strictEqual(denied.code, 1);
  assert.match(denied.stderr, /permission/);
  assert.ok(!fs.existsSync(path.join(bin, 'calls')));
  const ok = await merge(bin, { repo: 'acme/mine', number: 4, method: 'squash' });
  assert.strictEqual(ok.code, 0);
  assert.match(fs.readFileSync(path.join(bin, 'calls'), 'utf8'), /pr merge 4 --squash -R acme\/mine/);
});
