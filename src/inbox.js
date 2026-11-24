// GitHub inbox: polls your GitHub notifications through gh and reports new ones.
const { run } = require('./exec');
const os = require('node:os');

const REASONS = {
  review_requested: 'Review requested',
  approval_requested: 'Approval requested',
  mention: 'You were mentioned',
  team_mention: 'Your team was mentioned',
  comment: 'New comment',
  author: 'Activity on your thread',
  assign: 'Assigned to you',
  ci_activity: 'CI run finished',
  state_change: 'Closed or merged',
  manual: 'Subscribed thread',
  subscribed: 'Watched repository',
  security_alert: 'Security alert',
  invitation: 'Invitation',
};

/** Turn an API URL from a notification into the page you'd open in a browser. */
function htmlUrl(n) {
  const repo = n.repository?.full_name;
  const api = n.subject?.url || '';
  const m = api.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/]+)$/);
  if (m) {
    const kind = { pulls: 'pull', issues: 'issues', commits: 'commit', releases: 'releases' }[m[2]];
    if (kind === 'releases') return `https://github.com/${m[1]}/releases`;
    return `https://github.com/${m[1]}/${kind}/${m[3]}`;
  }
  if (n.subject?.type === 'CheckSuite' || n.reason === 'ci_activity') return `https://github.com/${repo}/actions`;
  if (n.subject?.type === 'Discussion') return `https://github.com/${repo}/discussions`;
  return repo ? `https://github.com/${repo}` : 'https://github.com/notifications';
}

function normalize(n) {
  return {
    id: String(n.id),
    unread: Boolean(n.unread),
    reason: n.reason,
    reasonLabel: REASONS[n.reason] || n.reason,
    type: n.subject?.type || '',
    title: n.subject?.title || '(no title)',
    repo: n.repository?.full_name || '',
    updatedAt: n.updated_at,
    url: htmlUrl(n),
  };
}

class Inbox {
  /**
   * @param {{onUpdate: (items: object[]) => void, onNew: (items: object[]) => void, intervalMs?: number}} opts
   */
  constructor({ onUpdate, onNew, intervalMs = 60_000 }) {
    this.onUpdate = onUpdate;
    this.onNew = onNew;
    this.intervalMs = intervalMs;
    this.items = [];
    this.seen = new Set(); // id@updatedAt keys we've already told the user about
    this.primed = false;
    this.error = null;
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  get unreadCount() {
    return this.items.filter((i) => i.unread).length;
  }

  async poll() {
    const res = await run('gh', ['api', 'notifications?all=false&per_page=50'], os.homedir());
    if (res.code !== 0) {
      this.error = /not installed/.test(res.stderr)
        ? 'GitHub CLI (gh) is not installed.'
        : /auth|login|401/i.test(res.stderr)
          ? 'GitHub CLI is not signed in. Run: gh auth login'
          : (res.stderr || 'Could not load notifications').trim().split('\n')[0];
      this.onUpdate(this.items);
      return;
    }
    this.error = null;
    let raw = [];
    try {
      raw = JSON.parse(res.stdout || '[]');
    } catch {
      return;
    }
    this.items = raw.map(normalize).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const fresh = [];
    for (const it of this.items) {
      const key = `${it.id}@${it.updatedAt}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        if (this.primed && it.unread) fresh.push(it);
      }
    }
    // On the first poll, only count what's there; don't pop an alert for every old notification.
    this.primed = true;
    if (fresh.length) this.onNew(fresh);
    this.onUpdate(this.items);
  }

  async markRead(id) {
    const r = await run('gh', ['api', '-X', 'PATCH', `notifications/threads/${encodeURIComponent(id)}`], os.homedir());
    if (r.code === 0) {
      const it = this.items.find((i) => i.id === String(id));
      if (it) it.unread = false;
      this.items = this.items.filter((i) => i.unread);
      this.onUpdate(this.items);
    }
    return r;
  }

  async markAllRead() {
    const r = await run('gh', ['api', '-X', 'PUT', 'notifications', '-F', 'read=true'], os.homedir());
    if (r.code === 0) {
      this.items = [];
      this.onUpdate(this.items);
    }
    return r;
  }
}

module.exports = { Inbox, htmlUrl, normalize };
