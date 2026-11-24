// Use your Claude plan through the Claude Code CLI (`claude -p`), no API key needed.
// Claude Code gets no built-in tools. Its only tools are Rev's `git` and `gh`, served from a small
// MCP server inside Rev on 127.0.0.1, so every command still goes through Rev's risk check and Approve button.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SYSTEM, TOOL_DEFS, TOOL_ARGS_SCHEMA, runTool } = require('./agent');

const { searchPath } = require('./exec');

const IS_WIN = process.platform === 'win32';
// On Windows the native installer makes claude.exe; an npm install makes claude.cmd.
const NAMES = IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];

const CANDIDATES = () => {
  const dirs = [
    path.join(os.homedir(), '.claude', 'local'),
    path.join(os.homedir(), '.local', 'bin'),
    ...(IS_WIN ? [] : [path.join(os.homedir(), '.homebrew', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']),
    ...searchPath().split(path.delimiter).filter(Boolean),
  ];
  return [process.env.REV_CLAUDE_BIN, ...dirs.flatMap((d) => NAMES.map((n) => path.join(d, n)))];
};

function usable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK); // Windows has no execute bit
    return true;
  } catch {
    return false;
  }
}

/** Path of the claude CLI, or null when it isn't installed. */
function findClaude() {
  for (const p of CANDIDATES()) if (p && usable(p)) return p;
  return null;
}

/**
 * How to start the CLI at `bin` without a shell. Node refuses to spawn .cmd/.bat files without one,
 * and a shell would mangle the JSON and prompt we pass, so an npm install on Windows runs its cli.js
 * with Node directly (Electron acts as Node when ELECTRON_RUN_AS_NODE is set).
 */
function launchSpec(bin, platform = process.platform) {
  const viaNode = (script) => ({ cmd: process.execPath, pre: [script], env: { ELECTRON_RUN_AS_NODE: '1' } });
  if (/\.(c|m)?js$/i.test(bin)) return viaNode(bin);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const cli = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cli)) return viaNode(cli);
    return null;
  }
  return { cmd: bin, pre: [], env: {} };
}

// ---------- the MCP server (Streamable HTTP, JSON responses) ----------
let server = null;
let serverUrl = null;
let activeCtx = null; // the conversation currently using the tools

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // a notification: no reply
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'rev', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: TOOL_ARGS_SCHEMA })) });
    case 'tools/call': {
      const name = params?.name;
      if (name !== 'git' && name !== 'gh') return rpcError(id, -32602, `Unknown tool ${name}`);
      if (!activeCtx) return rpcResult(id, { content: [{ type: 'text', text: 'Rev is not running a request right now.' }], isError: true });
      const text = await runTool(name, params?.arguments?.args, activeCtx);
      return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Start the local MCP server once; the URL carries a random secret so other apps can't use it. */
function ensureServer() {
  if (server) return Promise.resolve(serverUrl);
  const secret = crypto.randomBytes(24).toString('hex');
  const route = `/mcp/${secret}`;
  server = http.createServer((req, res) => {
    if (req.url !== route) { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const batch = Array.isArray(msg);
      const replies = (await Promise.all((batch ? msg : [msg]).map(handleRpc))).filter(Boolean);
      if (!replies.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref(); // don't keep Rev (or a test run) alive just for this
      serverUrl = `http://127.0.0.1:${server.address().port}${route}`;
      resolve(serverUrl);
    });
  });
}

// ---------- running claude -p ----------
class ClaudeCodeRunner {
  constructor() {
    this.sessionId = null; // resumed on the next message so the conversation continues
    this.child = null;
  }

  reset() { this.sessionId = null; }

  cancel() { if (this.child) this.child.kill('SIGTERM'); }

  async send(prompt, ctx) {
    const bin = findClaude();
    const launch = bin && launchSpec(bin);
    if (!launch) {
      ctx.emit({ type: 'error', text: 'Claude Code is not installed. Install it from claude.com/code, sign in by running `claude` once in a terminal, then try again.' });
      ctx.emit({ type: 'done' });
      return;
    }
    const url = await ensureServer();
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--tools', '', // no built-in tools: no shell, no file edits
      '--mcp-config', JSON.stringify({ mcpServers: { rev: { type: 'http', url } } }),
      '--strict-mcp-config',
      '--allowedTools', 'mcp__rev__git', 'mcp__rev__gh',
      '--system-prompt', `${SYSTEM}\n\nRepository: ${ctx.cwd}\nUse the git and gh tools (mcp__rev__git, mcp__rev__gh) for everything.`,
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);
    // Use the Claude plan you're signed in with, not an API key that may be set in the environment.
    const env = { ...process.env, PATH: searchPath(), ...launch.env, MCP_TOOL_TIMEOUT: String(30 * 60 * 1000) };
    delete env.Path;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    activeCtx = ctx;
    let sawText = false;
    let finalError = null;
    let stderr = '';
    await new Promise((resolve) => {
      const child = spawn(launch.cmd, [...launch.pre, ...args], { cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.session_id) this.sessionId = ev.session_id;
          if (ev.type === 'assistant') {
            for (const b of ev.message?.content || []) {
              if (b.type === 'text' && b.text.trim()) { sawText = true; ctx.emit({ type: 'text', text: b.text.trim() }); }
            }
          } else if (ev.type === 'result') {
            if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) finalError = String(ev.result || ev.subtype || 'Claude Code failed');
            else if (!sawText && ev.result) ctx.emit({ type: 'text', text: String(ev.result).trim() });
          }
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('error', (e) => { finalError = e.message; resolve(); });
      child.on('close', (code, signal) => {
        if (signal) finalError = 'Stopped.';
        else if (code !== 0 && !finalError) finalError = stderr.trim().split('\n').slice(-3).join('\n') || `Claude Code exited with code ${code}`;
        resolve();
      });
    });
    this.child = null;
    activeCtx = null;
    if (finalError) {
      const text = /log ?in|logged|auth|api key|credential|oauth/i.test(finalError) && finalError !== 'Stopped.'
        ? 'Claude Code is not signed in. Run `claude` in a terminal, sign in with your Claude account, then try again.'
        : finalError;
      ctx.emit({ type: 'error', text });
    }
    ctx.emit({ type: 'done' });
  }
}

module.exports = { ClaudeCodeRunner, findClaude, launchSpec, ensureServer, handleRpc };
