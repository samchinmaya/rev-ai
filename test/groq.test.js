// Checks the Groq path: OpenAI-style /chat/completions with Bearer auth, a preferred model, and a tool round trip.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('agent runs git through Groq tool calls', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revgq-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models')) {
        return res.end(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }] }));
      }
      const body = JSON.parse(b);
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const reply = seen.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'git', arguments: '{"args":["status","--short"]}' } }] }
        : { role: 'assistant', content: 'Working tree is clean.' };
      res.end(JSON.stringify({ choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.REV_GROQ_BASE = `http://127.0.0.1:${server.address().port}`;
  const { Agent } = require('../src/agent');
  const events = [];
  await new Agent().send('status?', {
    provider: { type: 'groq', key: 'gsk_test' }, cwd: repo, emit: (e) => events.push(e), confirm: async () => false,
  });
  server.close();
  assert.deepStrictEqual(events.filter((e) => e.type === 'error'), []);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].url, '/chat/completions');
  assert.strictEqual(seen[0].auth, 'Bearer gsk_test');
  assert.strictEqual(seen[0].body.model, 'openai/gpt-oss-120b');
  assert.deepStrictEqual(seen[0].body.tools.map((t) => t.function.name), ['git', 'gh']);
  const toolMsg = seen[1].body.messages.find((m) => m.role === 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /^exit code 0/);
  assert.ok(events.some((e) => e.type === 'cmd' && e.command === 'git status --short' && e.status === 'ok'));
  assert.ok(events.some((e) => e.type === 'text' && /clean/.test(e.text)));
});
