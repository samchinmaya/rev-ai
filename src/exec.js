// Runs git / gh without a shell, with a PATH that works when the app is launched from Finder.
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.homebrew', 'bin'),
  '/usr/bin',
  '/bin',
];

function env() {
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  for (const p of EXTRA_PATHS) if (!parts.includes(p)) parts.push(p);
  return {
    ...process.env,
    PATH: parts.join(':'),
    GIT_TERMINAL_PROMPT: '0', // never hang waiting for a password prompt
    GIT_EDITOR: 'true', // rebase --continue / merge commits keep their default message
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
}

/** Run a command; always resolves with { code, stdout, stderr }. */
function run(cmd, args, cwd, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: env(), timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : 1;
        if (err && err.code === 'ENOENT') stderr = `${cmd} is not installed or not on PATH`;
        if (err && err.killed) stderr = `${stderr}\n(timed out after ${timeoutMs / 1000}s)`;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

module.exports = { run };
