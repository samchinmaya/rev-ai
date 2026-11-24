// Runs git / gh without a shell, with a PATH that works when the app is launched from Finder,
// the Start menu or a Linux desktop launcher (which often start apps with a minimal PATH).
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();

/** Folders where git, gh and claude usually live on each OS, added after the user's own PATH. */
function extraPaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return [
      path.win32.join(pf, 'Git', 'cmd'),
      path.win32.join(pf86, 'Git', 'cmd'),
      path.win32.join(local, 'Programs', 'Git', 'cmd'),
      path.win32.join(pf, 'GitHub CLI'),
      path.win32.join(pf86, 'GitHub CLI'),
      path.win32.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.win32.join(home, 'scoop', 'shims'),
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(roaming, 'npm'),
    ];
  }
  const common = ['/usr/local/bin', '/usr/bin', '/bin', path.posix.join(home, '.local', 'bin')];
  if (platform === 'darwin') return ['/opt/homebrew/bin', path.posix.join(home, '.homebrew', 'bin'), ...common];
  // Linux and other Unixes: Homebrew on Linux, Snap and Nix profiles too.
  return [...common, '/home/linuxbrew/.linuxbrew/bin', path.posix.join(home, '.linuxbrew', 'bin'), '/snap/bin', path.posix.join(home, '.nix-profile', 'bin'), '/run/current-system/sw/bin'];
}

/** The user's PATH plus the usual install folders, joined with the OS's separator. */
function searchPath(platform = process.platform, env = process.env) {
  const sep = platform === 'win32' ? ';' : ':';
  // Windows env var names are case-insensitive; Node exposes PATH as "Path" sometimes.
  const raw = env.PATH ?? env.Path ?? '';
  const parts = raw.split(sep).filter(Boolean);
  const seen = new Set(parts.map((p) => (platform === 'win32' ? p.toLowerCase() : p)));
  for (const p of extraPaths(platform, env)) {
    const k = platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(k)) { parts.push(p); seen.add(k); }
  }
  return parts.join(sep);
}

function env() {
  const e = { ...process.env };
  // Keep exactly one PATH key so Windows doesn't end up with both "Path" and "PATH".
  delete e.Path;
  e.PATH = searchPath();
  return {
    ...e,
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
      { cwd: cwd || home, env: env(), timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
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

/** How to install the GitHub CLI on this OS, for error messages. */
function ghInstallHint(platform = process.platform) {
  if (platform === 'win32') return 'winget install --id GitHub.cli';
  if (platform === 'darwin') return 'brew install gh';
  return 'see cli.github.com for your distro (e.g. sudo apt install gh / sudo dnf install gh / sudo pacman -S github-cli)';
}

module.exports = { run, env, searchPath, extraPaths, ghInstallHint };
