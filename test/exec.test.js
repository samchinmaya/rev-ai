const test = require('node:test');
const assert = require('node:assert');
const { searchPath, extraPaths, ghInstallHint } = require('../src/exec');

test('Windows PATH uses ; and picks up Git and GitHub CLI folders', () => {
  const env = { Path: 'C:\\Windows\\system32', ProgramFiles: 'C:\\Program Files' };
  const p = searchPath('win32', env).split(';');
  assert.strictEqual(p[0], 'C:\\Windows\\system32');
  assert.ok(p.includes('C:\\Program Files\\Git\\cmd'));
  assert.ok(p.includes('C:\\Program Files\\GitHub CLI'));
});

test('Linux PATH uses : and adds snap and linuxbrew, without duplicates', () => {
  const p = searchPath('linux', { PATH: '/usr/bin:/bin' }).split(':');
  assert.ok(p.includes('/snap/bin'));
  assert.ok(p.includes('/home/linuxbrew/.linuxbrew/bin'));
  assert.strictEqual(p.filter((x) => x === '/usr/bin').length, 1);
});

test('macOS keeps Homebrew paths', () => {
  assert.ok(extraPaths('darwin').includes('/opt/homebrew/bin'));
  assert.match(ghInstallHint('darwin'), /brew/);
  assert.match(ghInstallHint('win32'), /winget/);
});
