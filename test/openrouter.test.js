// Checks the OpenRouter path: Bearer auth, Anthropic-style /v1/messages, newest Opus picked, no Anthropic-only params.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('agent talks to OpenRouter with the Anthropic Messages format', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revor-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/models')) {
        return res.end(JSON.stringify({ data: [
          { id: 'anthropic/claude-opus-4.1', created: 1 }, { id: 'anthropic/claude-opus-9', created: 9 },
          { id: 'anthropic/claude-sonnet-9', created: 99 }, { id: 'openai/gpt-x', created: 100 },
        ] }));
      }
      seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'], body: JSON.parse(b) });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'Clean working tree.' }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.REV_OPENROUTER_BASE = `http://127.0.0.1:${server.address().port}`;
  const { Agent } = require('../src/agent');
  const events = [];
  await new Agent().send('status?', {
    provider: { type: 'openrouter', key: 'sk-or-test' }, cwd: repo, emit: (e) => events.push(e), confirm: async () => false,
  });
  server.close();
  assert.deepStrictEqual(events.filter((e) => e.type === 'error'), []);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].url, /^\/v1\/messages/);
  assert.strictEqual(seen[0].auth, 'Bearer sk-or-test');
  assert.ok(!seen[0].xkey, 'no x-api-key header');
  assert.strictEqual(seen[0].body.model, 'anthropic/claude-opus-9');
  assert.strictEqual(seen[0].body.fallbacks, undefined);
  assert.ok(events.some((e) => e.type === 'text' && /Clean/.test(e.text)));
});
