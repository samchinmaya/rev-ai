// Checks the GitHub inbox with a fake gh on PATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'));
const data = path.join(bin, 'data.json');
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$2" = "-X" ]; then echo "$@" >> ${bin}/calls; exit 0; fi\ncat ${data}\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { Inbox, htmlUrl } = require('../src/inbox');

const note = (id, reason, updated, extra = {}) => ({
  id, unread: true, reason, updated_at: updated,
  subject: { title: `t${id}`, type: 'PullRequest', url: `https://api.github.com/repos/o/r/pulls/${id}` },
  repository: { full_name: 'o/r' }, ...extra,
});

test('maps API urls to web pages', () => {
  assert.strictEqual(htmlUrl(note('7', 'comment', 'x')), 'https://github.com/o/r/pull/7');
  assert.strictEqual(htmlUrl({ reason: 'ci_activity', subject: { type: 'CheckSuite', url: null }, repository: { full_name: 'o/r' } }), 'https://github.com/o/r/actions');
});

test('only alerts for notifications that arrive after start', async () => {
  fs.writeFileSync(data, JSON.stringify([note('1', 'comment', '2026-01-01T00:00:00Z')]));
  const fresh = [];
  let last = [];
  const inbox = new Inbox({ onUpdate: (i) => (last = i), onNew: (f) => fresh.push(...f) });
  await inbox.poll();
  assert.strictEqual(fresh.length, 0, 'existing notifications are not re-announced');
  assert.strictEqual(last.length, 1);

  fs.writeFileSync(data, JSON.stringify([note('2', 'review_requested', '2026-01-02T00:00:00Z'), note('1', 'comment', '2026-01-01T00:00:00Z')]));
  await inbox.poll();
  assert.deepStrictEqual(fresh.map((f) => f.reasonLabel), ['Review requested']);
  assert.strictEqual(inbox.unreadCount, 2);

  // a new comment on an old thread bumps updated_at and alerts again
  fs.writeFileSync(data, JSON.stringify([note('1', 'comment', '2026-01-03T00:00:00Z'), note('2', 'review_requested', '2026-01-02T00:00:00Z')]));
  await inbox.poll();
  assert.strictEqual(fresh.length, 2);

  await inbox.markRead('2');
  assert.strictEqual(inbox.unreadCount, 1);
  assert.match(fs.readFileSync(path.join(bin, 'calls'), 'utf8'), /PATCH notifications\/threads\/2/);
});
