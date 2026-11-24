// Checks the Claude Code path with a fake `claude` that behaves like the CLI:
// it connects to Rev's MCP server, lists tools, calls git, and prints stream-json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeclaude-'));
// Windows can't run a shebang script, so there the fake is a .js file that Rev starts with Node.
const fake = path.join(dir, process.platform === 'win32' ? 'claude.js' : 'claude');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify({ args: a, apiKey: process.env.ANTHROPIC_API_KEY || null }));
const url = JSON.parse(a[a.indexOf('--mcp-config') + 1]).mcpServers.rev.url;
const rpc = async (id, method, params) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
(async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
  const tools = (await rpc(2, 'tools/list')).result.tools.map((t) => t.name);
  const call = await rpc(3, 'tools/call', { name: 'git', arguments: { args: ['status', '--short'] } });
  const denied = await rpc(4, 'tools/call', { name: 'git', arguments: { args: ['push', '--force'] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'tools=' + tools.join(',') + ' first=' + call.result.content[0].text.split('\\n')[0] + ' second=' + denied.result.content[0].text.slice(0, 20) }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1' });
})();
`, { mode: 0o755 });
process.env.REV_CLAUDE_BIN = fake;
process.env.ANTHROPIC_API_KEY = 'should-not-be-passed';

test('Claude Code runs Rev tools through the approval gate', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revcc-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const { ClaudeCodeRunner, findClaude } = require('../src/claudecode');
  assert.strictEqual(findClaude(), fake);
  const runner = new ClaudeCodeRunner();
  const events = [];
  const asked = [];
  await runner.send('status?', { provider: { type: 'claude-code' }, cwd: repo, emit: (e) => events.push(e),
    confirm: async (req) => { asked.push(req.command); return false; } });
  assert.deepStrictEqual(events.filter((e) => e.type === 'error'), []);
  const text = events.find((e) => e.type === 'text').text;
  assert.match(text, /tools=git,gh/);
  assert.match(text, /first=exit code 0/);
  assert.match(text, /second=The user declined/);
  assert.deepStrictEqual(asked, ['git push --force']);
  assert.ok(events.some((e) => e.type === 'cmd' && e.command === 'git push --force' && e.status === 'denied'));
  assert.strictEqual(runner.sessionId, 'sess-1');
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.strictEqual(seen.apiKey, null, 'API key from the environment is not passed to Claude Code');
  assert.strictEqual(seen.args[seen.args.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.ok(seen.args.includes('--strict-mcp-config'));
  assert.ok(!seen.args.includes('--resume'));
  // the next message resumes the same conversation
  await runner.send('again', { provider: { type: 'claude-code' }, cwd: repo, emit: () => {}, confirm: async () => false });
  const again = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')).args;
  assert.strictEqual(again[again.indexOf('--resume') + 1], 'sess-1');
});

test('launchSpec runs .js and npm .cmd installs through Node, native binaries directly', () => {
  const { launchSpec } = require('../src/claudecode');
  assert.deepStrictEqual(launchSpec('/usr/local/bin/claude', 'linux'), { cmd: '/usr/local/bin/claude', pre: [], env: {} });
  const js = launchSpec(fake.replace(/(\.js)?$/, '.js'), 'linux');
  assert.strictEqual(js.cmd, process.execPath);
  assert.strictEqual(js.env.ELECTRON_RUN_AS_NODE, '1');
  // an npm shim with no cli.js next to it can't be started safely
  assert.strictEqual(launchSpec(path.join(dir, 'claude.cmd'), 'win32'), null);
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmshim-'));
  const cli = path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  assert.deepStrictEqual(launchSpec(path.join(npmDir, 'claude.cmd'), 'win32').pre, [cli]);
});
