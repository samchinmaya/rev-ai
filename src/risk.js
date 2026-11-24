// Decides which git / gh commands need the user's approval before they run.
// Returns { level: 'safe' | 'confirm' | 'danger' | 'blocked', why }.

const PROTECTED = new Set(['main', 'master', 'develop', 'trunk', 'production', 'release']);

function has(args, ...flags) {
  return args.some((a) => flags.includes(a) || flags.some((f) => f.endsWith('=') && a.startsWith(f)));
}

function sub(args) {
  // skip global options like -C <dir>, -c k=v
  const out = [...args];
  while (out.length && out[0].startsWith('-')) {
    const o = out.shift();
    if (o === '-C' || o === '-c') out.shift();
  }
  return out;
}

function classifyGit(rawArgs) {
  const args = sub(rawArgs);
  const [cmd, ...rest] = args;
  if (!cmd) return { level: 'blocked', why: 'No git subcommand given.' };
  if (has(rest, '-i', '--interactive') && ['rebase', 'add', 'commit', 'clean'].includes(cmd)) {
    return { level: 'blocked', why: 'Interactive mode needs a terminal and is not supported here.' };
  }
  switch (cmd) {
    case 'push': {
      if (has(rest, '--force', '-f', '--force-with-lease', '--force-with-lease=', '--force-if-includes')) {
        return { level: 'danger', why: 'Force push rewrites history on the remote.' };
      }
      if (rest.some((a) => /^\+/.test(a))) return { level: 'danger', why: 'A "+" refspec force-pushes.' };
      if (has(rest, '--delete', '-d') || rest.some((a) => /^:/.test(a))) {
        return { level: 'danger', why: 'Deletes a branch or tag on the remote.' };
      }
      if (has(rest, '--mirror', '--prune')) return { level: 'danger', why: 'Can delete remote refs.' };
      const target = rest.filter((a) => !a.startsWith('-')).slice(1);
      const hitsProtected = target.some((r) => PROTECTED.has(r.split(':').pop().replace(/^refs\/heads\//, '')));
      if (hitsProtected) return { level: 'confirm', why: 'Pushes directly to a protected branch.' };
      return { level: 'safe' };
    }
    case 'rebase':
      if (has(rest, '--abort', '--continue', '--skip', '--quit')) return { level: 'safe' };
      return { level: 'danger', why: 'Rebase rewrites commit history.' };
    case 'reset':
      if (has(rest, '--hard', '--merge', '--keep')) return { level: 'danger', why: 'Discards uncommitted work.' };
      return { level: 'confirm', why: 'Moves the branch pointer.' };
    case 'clean':
      return { level: 'danger', why: 'Permanently deletes untracked files.' };
    case 'checkout':
    case 'switch':
      if (has(rest, '-f', '--force', '--discard-changes')) return { level: 'danger', why: 'Throws away local changes.' };
      if (cmd === 'checkout' && (rest.includes('--') || rest.includes('.'))) {
        return { level: 'danger', why: 'Overwrites files with the committed version.' };
      }
      if (has(rest, '-B', '-C')) return { level: 'confirm', why: 'Resets an existing branch.' };
      return { level: 'safe' };
    case 'restore':
      if (has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W')) return { level: 'safe' };
      return { level: 'danger', why: 'Discards changes in your working tree.' };
    case 'branch':
      if (has(rest, '-D', '--force', '-f') || (has(rest, '-d', '--delete') && has(rest, '-f', '--force'))) {
        return { level: 'danger', why: 'Force-deletes or force-moves a branch.' };
      }
      if (has(rest, '-d', '--delete')) return { level: 'confirm', why: 'Deletes a local branch.' };
      if (has(rest, '-M', '-C')) return { level: 'confirm', why: 'Overwrites a branch name.' };
      return { level: 'safe' };
    case 'stash':
      if (['drop', 'clear'].includes(rest[0])) return { level: 'danger', why: 'Permanently deletes stashed work.' };
      return { level: 'safe' };
    case 'commit':
      if (has(rest, '--amend')) return { level: 'confirm', why: 'Rewrites the last commit.' };
      return { level: 'safe' };
    case 'tag':
      if (has(rest, '-d', '--delete', '-f', '--force')) return { level: 'confirm', why: 'Deletes or moves a tag.' };
      return { level: 'safe' };
    case 'remote':
      if (['remove', 'rm', 'set-url', 'prune'].includes(rest[0])) return { level: 'confirm', why: 'Changes remote config.' };
      return { level: 'safe' };
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
    case 'reflog':
    case 'gc':
    case 'prune':
    case 'replace':
      if (cmd === 'reflog' && (!rest[0] || rest[0] === 'show')) return { level: 'safe' };
      return { level: 'danger', why: 'Low-level history rewrite or cleanup.' };
    case 'worktree':
      if (['remove', 'prune'].includes(rest[0])) return { level: 'confirm', why: 'Removes a worktree.' };
      return { level: 'safe' };
    case 'config':
      if (rest.some((a) => /credential|sshCommand|core\.hooksPath|alias\./i.test(a)) && rest.length > 1) {
        return { level: 'confirm', why: 'Changes sensitive git config.' };
      }
      return { level: 'safe' };
    default:
      return { level: 'safe' };
  }
}

const GH_WRITE_PR = new Set(['create', 'merge', 'close', 'reopen', 'comment', 'review', 'edit', 'ready', 'lock', 'unlock', 'update-branch']);

function classifyGh(args) {
  const [group, action, ...rest] = args;
  if (!group) return { level: 'blocked', why: 'No gh command given.' };
  if (group === 'auth' && action !== 'status') return { level: 'blocked', why: 'Auth commands are not allowed from the assistant.' };
  if (group === 'secret' || group === 'ssh-key' || group === 'gpg-key') {
    return action === 'list' ? { level: 'safe' } : { level: 'blocked', why: 'Key and secret management is not allowed from the assistant.' };
  }
  if (group === 'repo' && ['delete', 'archive', 'rename', 'edit'].includes(action)) {
    return { level: 'danger', why: `gh repo ${action} changes the repository itself.` };
  }
  if (group === 'pr' && action === 'merge') return { level: 'danger', why: 'Merges the pull request on GitHub.' };
  if (group === 'pr' && action === 'close') return { level: 'danger', why: 'Closes the pull request on GitHub.' };
  if (group === 'pr' && GH_WRITE_PR.has(action)) return { level: 'confirm', why: `Posts to GitHub (gh pr ${action}).` };
  if (group === 'issue' && ['create', 'close', 'delete', 'comment', 'edit', 'transfer', 'reopen'].includes(action)) {
    return { level: 'confirm', why: `Posts to GitHub (gh issue ${action}).` };
  }
  if (group === 'release' && action !== 'list' && action !== 'view') return { level: 'confirm', why: 'Changes a release.' };
  if (group === 'api') {
    const all = [action, ...rest];
    const mIdx = all.findIndex((a) => a === '-X' || a === '--method');
    const method = (mIdx >= 0 ? all[mIdx + 1] : all.find((a) => a.startsWith('--method='))?.split('=')[1]) || '';
    const hasFields = all.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
    if (/^(DELETE)$/i.test(method)) return { level: 'danger', why: 'DELETE request to the GitHub API.' };
    if (method && !/^GET$/i.test(method)) return { level: 'confirm', why: `${method.toUpperCase()} request to the GitHub API.` };
    if (!method && hasFields) return { level: 'confirm', why: 'POST request to the GitHub API.' };
    return { level: 'safe' };
  }
  if (group === 'workflow' && ['run', 'enable', 'disable'].includes(action)) return { level: 'confirm', why: 'Changes GitHub Actions.' };
  if (group === 'run' && ['cancel', 'rerun', 'delete'].includes(action)) return { level: 'confirm', why: 'Changes a workflow run.' };
  return { level: 'safe' };
}

module.exports = { classifyGit, classifyGh };
