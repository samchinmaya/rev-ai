// Drives the agent against a fake Messages API to check the tool loop, approvals and history.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('agent runs git, asks before force push, keeps history', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revtest-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

  const bodies = [];
  const script = [
    { content: [{ type: 'tool_use', id: 't1', name: 'git', input: { args: ['status', '--short', '--branch'] } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 't2', name: 'git', input: { args: ['push', '--force'] } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'You declined the force push, so I stopped.' }], stop_reason: 'end_turn' },
  ];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push(JSON.parse(b));
      const step = script[bodies.length - 1];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `msg_${bodies.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        stop_reason: step.stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: step.content }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const { Agent } = require('../src/agent');
  const agent = new Agent();
  const events = [];
  const asked = [];
  await agent.send('force push please', {
    provider: { type: 'anthropic', key: 'test' }, cwd: repo, emit: (e) => events.push(e),
    confirm: async (req) => { asked.push(req.command); return false; },
  });
  server.close();

  const errs = events.filter((e) => e.type === 'error');
  assert.deepStrictEqual(errs, []);
  assert.strictEqual(bodies.length, 3);
  assert.strictEqual(bodies[0].model, 'claude-opus-5-5');
  assert.strictEqual(bodies[0].fallbacks, 'default');
  assert.deepStrictEqual(asked, ['git push --force']);
  const status = events.find((e) => e.type === 'cmd' && e.status === 'ok');
  assert.match(status.output, /No commits yet on main|## main/);
  assert.ok(events.some((e) => e.type === 'cmd' && e.status === 'denied'));
  const t2 = bodies[2].messages.at(-1).content.find((c) => c.tool_use_id === 't2');
  assert.match(JSON.stringify(t2.content), /declined/);
  assert.strictEqual(agent.history.at(-1).role, 'assistant');
  assert.strictEqual(events.at(-1).type, 'done');
});
