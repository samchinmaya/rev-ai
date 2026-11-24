// The git/GitHub agent: Claude plans, and runs git / gh through two tools.
// Risky commands pause for the user's approval in the overlay before they run.
const Anthropic = require('@anthropic-ai/sdk');
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const { run } = require('./exec');
const { classifyGit, classifyGh } = require('./risk');

const MODEL = 'claude-opus-5-5';
const OPENROUTER_BASE = process.env.REV_OPENROUTER_BASE || 'https://openrouter.ai/api';
const OPENROUTER_FALLBACK_MODEL = 'anthropic/claude-opus-4.5';
let openRouterModel = null;

/** Pick the newest Claude Opus that OpenRouter offers (looked up once per launch). */
async function resolveOpenRouterModel() {
  if (openRouterModel) return openRouterModel;
  if (process.env.REV_OPENROUTER_MODEL) return (openRouterModel = process.env.REV_OPENROUTER_MODEL);
  try {
    const res = await fetch(`${OPENROUTER_BASE}/v1/models`);
    const { data } = await res.json();
    const opus = data
      .filter((m) => /^anthropic\/claude-opus/.test(m.id) && !/:/.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    openRouterModel = opus[0]?.id || OPENROUTER_FALLBACK_MODEL;
  } catch {
    openRouterModel = OPENROUTER_FALLBACK_MODEL;
  }
  return openRouterModel;
}

// Groq speaks the OpenAI Chat Completions API. We pick a strong tool-calling model it offers.
const GROQ_BASE = () => process.env.REV_GROQ_BASE || 'https://api.groq.com/openai/v1';
const GROQ_PREFERRED = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'];
const GROQ_FALLBACK_MODEL = 'llama-3.3-70b-versatile';
let groqModel = null;

/** Choose the Groq model once per launch (REV_GROQ_MODEL overrides). */
async function resolveGroqModel(key) {
  if (groqModel) return groqModel;
  if (process.env.REV_GROQ_MODEL) return (groqModel = process.env.REV_GROQ_MODEL);
  try {
    const res = await fetch(`${GROQ_BASE()}/models`, { headers: { Authorization: `Bearer ${key}` } });
    const ids = new Set(((await res.json()).data || []).filter((m) => m.active !== false).map((m) => m.id));
    groqModel = GROQ_PREFERRED.find((id) => ids.has(id)) || GROQ_FALLBACK_MODEL;
  } catch {
    groqModel = GROQ_FALLBACK_MODEL;
  }
  return groqModel;
}

const MAX_OUTPUT_CHARS = 12_000;

const SYSTEM = `You are Rev, a git and GitHub assistant that lives in a small floating window on the user's Mac.
You act on one local repository at a time by calling the git and gh tools. Each call runs one command, without a shell, in the repository directory.

How to work:
- Check state before acting: run git status / git branch / git log --oneline -n 5 when you need context. Don't guess branch names or remotes.
- Prefer the simplest command sequence that does what the user asked. Don't do extra things they didn't ask for.
- For commits, write a short, specific message from the actual diff (look at git diff --staged first) unless the user gave one.
- For PR work use gh (gh pr list/view/create/checks/merge/review). Use --json output where it helps you read results.
- Never use interactive flags (-i, -p) or anything that opens an editor; pass messages with -m / --body.
- Some commands (force push, rebase, reset --hard, branch deletion, merging or closing PRs, posting to GitHub) pause for the user's approval. If the user declines, stop and ask what they want instead; don't look for a workaround.
- If a command fails (merge conflicts, rejected push, auth errors), explain what happened in plain words and suggest the next step. For conflicts, list the conflicted files and stop.
- Keep replies short: the window is small. One or two sentences, plus a tiny list if needed. No headings.`;

function trim(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n…(${s.length - MAX_OUTPUT_CHARS} more characters cut)`;
}

const TOOL_ARGS_SCHEMA = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments after the command name, one per array item, e.g. ["status", "--short"].',
    },
  },
  required: ['args'],
  additionalProperties: false,
};
const TOOL_DEFS = [
  { name: 'git', description: 'Run one git command in the current repository.' },
  { name: 'gh', description: 'Run one GitHub CLI (gh) command in the current repository, for pull requests, reviews, checks and issues.' },
];

/** Run one git/gh call: classify it, ask for approval if risky, run it, report it to the UI. */
async function runTool(bin, args, ctx) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return 'Error: args must be an array of strings.';
  }
  const classify = bin === 'git' ? classifyGit : classifyGh;
  const command = `${bin} ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  const risk = classify(args);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (risk.level === 'blocked') {
    ctx.emit({ type: 'cmd', id, command, status: 'blocked', output: risk.why });
    return `Blocked: ${risk.why}`;
  }
  if (risk.level !== 'safe') {
    ctx.emit({ type: 'cmd', id, command, status: 'awaiting', level: risk.level, why: risk.why });
    const ok = await ctx.confirm({ id, command, level: risk.level, why: risk.why });
    if (!ok) {
      ctx.emit({ type: 'cmd', id, command, status: 'denied' });
      return 'The user declined this command. Do not run it or work around it; ask what they want instead.';
    }
  }
  ctx.emit({ type: 'cmd', id, command, status: 'running' });
  const res = await run(bin, args, ctx.cwd);
  const output = trim([res.stdout, res.stderr].filter(Boolean).join('\n').trim());
  ctx.emit({ type: 'cmd', id, command, status: res.code === 0 ? 'ok' : 'failed', output });
  return `exit code ${res.code}\n${output || '(no output)'}`;
}

class Agent {
  constructor() {
    this.history = [];
    this.groqHistory = [];
    this.abort = null;
  }

  reset() {
    this.history = [];
    this.groqHistory = [];
  }

  /** Groq: an OpenAI-style tool loop over /chat/completions. */
  async sendGroq(prompt, ctx) {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const messages = [...this.groqHistory, { role: 'user', content: prompt }];
    const tools = TOOL_DEFS.map((t) => ({ type: 'function', function: { ...t, parameters: TOOL_ARGS_SCHEMA } }));
    try {
      const model = await resolveGroqModel(ctx.provider.key);
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${GROQ_BASE()}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${ctx.provider.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: `${SYSTEM}\n\nRepository: ${ctx.cwd}` }, ...messages],
            tools,
            tool_choice: 'auto',
            max_tokens: 4096,
            temperature: 0.2,
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          const err = new Error(`Groq error ${res.status}: ${detail.slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        const msg = (await res.json()).choices?.[0]?.message || { role: 'assistant', content: '' };
        const calls = msg.tool_calls || [];
        messages.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (msg.content && msg.content.trim()) ctx.emit({ type: 'text', text: msg.content.trim() });
        if (!calls.length) break;
        for (const call of calls) {
          let out;
          const bin = call.function?.name;
          if (bin !== 'git' && bin !== 'gh') out = `Error: unknown tool ${bin}`;
          else {
            let input = {};
            try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* bad JSON from the model */ }
            out = await runTool(bin, input.args, ctx);
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: out });
        }
      }
      this.groqHistory = messages;
    } catch (err) {
      if (signal.aborted) ctx.emit({ type: 'error', text: 'Stopped.' });
      else if (err.status === 401) ctx.emit({ type: 'error', text: 'Your Groq API key was rejected. Update it in Settings.' });
      else if (err.status === 429) ctx.emit({ type: 'error', text: 'Groq rate limit reached. Try again in a moment.' });
      else if (err.name === 'TypeError') ctx.emit({ type: 'error', text: 'Could not reach Groq. Check your connection.' });
      else ctx.emit({ type: 'error', text: err?.message || String(err) });
    } finally {
      this.abort = null;
      ctx.emit({ type: 'done' });
    }
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  /**
   * @param {string} prompt
   * @param {{provider: {type: 'anthropic' | 'openrouter', key: string}, cwd: string, emit: (ev: object) => void, confirm: (req: object) => Promise<boolean>}} ctx
   */
  async send(prompt, ctx) {
    if (ctx.provider?.type === 'groq') return this.sendGroq(prompt, ctx);
    const openrouter = ctx.provider?.type === 'openrouter';
    // OpenRouter speaks the Anthropic Messages API at its own base URL, with a Bearer token.
    const client = openrouter
      ? new Anthropic({ baseURL: OPENROUTER_BASE, apiKey: null, authToken: ctx.provider.key, defaultHeaders: { 'X-Title': 'Rev AI' } })
      : new Anthropic({ apiKey: ctx.provider?.key || undefined });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const tools = TOOL_DEFS.map((t) =>
      betaTool({ name: t.name, description: t.description, inputSchema: TOOL_ARGS_SCHEMA, run: ({ args }) => runTool(t.name, args, ctx) }),
    );

    const messages = [...this.history, { role: 'user', content: prompt }];
    const base = {
      max_tokens: 16000,
      thread: false,
      system: `${SYSTEM}\n\nRepository: ${ctx.cwd}`,
      max_iterations: 25,
      tools,
      messages,
    };
    const params = openrouter
      ? { ...base, model: await resolveOpenRouterModel() } // keep to the plain Messages API fields OpenRouter accepts
      : {
          ...base,
          model: MODEL,
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          // If a safety classifier declines, the API retries on a fallback model in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        };
    const runner = client.beta.messages.toolRunner(params, { signal });

    let last = null;
    try {
      for await (const message of runner) {
        last = message;
        for (const block of message.content) {
          if (block.type === 'text' && block.text.trim()) ctx.emit({ type: 'text', text: block.text });
        }
        if (message.stop_reason === 'refusal') {
          ctx.emit({ type: 'error', text: 'Claude declined this request.' });
        }
      }
      const hist = [...runner.params.messages];
      if (last && hist[hist.length - 1]?.role !== 'assistant') hist.push({ role: 'assistant', content: last.content });
      this.history = hist;
    } catch (err) {
      if (signal.aborted) {
        ctx.emit({ type: 'error', text: 'Stopped.' });
      } else if (err instanceof Anthropic.AuthenticationError) {
        ctx.emit({ type: 'error', text: `Your ${openrouter ? 'OpenRouter' : 'Anthropic'} API key was rejected. Update it in Settings.` });
      } else if (err instanceof Anthropic.RateLimitError) {
        ctx.emit({ type: 'error', text: 'Rate limited by the API. Try again in a moment.' });
      } else if (err instanceof Anthropic.APIConnectionError) {
        ctx.emit({ type: 'error', text: `Could not reach ${openrouter ? 'OpenRouter' : 'the Anthropic API'}. Check your connection.` });
      } else if (openrouter && err?.status === 402) {
        ctx.emit({ type: 'error', text: 'OpenRouter says this key is out of credits. Add credits at openrouter.ai.' });
      } else {
        ctx.emit({ type: 'error', text: err?.message || String(err) });
      }
      // Keep history consistent: drop the turn that failed.
    } finally {
      this.abort = null;
      ctx.emit({ type: 'done' });
    }
  }
}

module.exports = { Agent, MODEL, SYSTEM, TOOL_DEFS, TOOL_ARGS_SCHEMA, runTool, resolveOpenRouterModel, resolveGroqModel };
