/* global rev */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let state = null;
const welcome = document.querySelector('#log .hint').cloneNode(true);
let busy = false;
const cmdCards = new Map();

// ---------- text rendering (safe: only builds text nodes and <code>) ----------
function richText(node, text) {
  text.split(/(`[^`]+`)/g).forEach((part) => {
    if (/^`[^`]+`$/.test(part)) node.appendChild(el('code', null, part.slice(1, -1)));
    else node.appendChild(document.createTextNode(part.replace(/\*\*(.+?)\*\*/g, '$1')));
  });
  return node;
}

function scroll() {
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}

function addMsg(kind, text) {
  $('log').querySelector('.hint')?.remove();
  const m = richText(el('div', `msg ${kind}`), text);
  $('log').appendChild(m);
  scroll();
}

// ---------- header / repo ----------
async function refreshRepo(info) {
  const repo = info !== undefined ? info : await rev.repoInfo();
  state.repo = repo;
  $('repoBtn').textContent = repo && !repo.error ? repo.name : 'Choose Repository';
  $('repoBtn').title = repo?.dir || 'Choose repository';
  if (!repo) $('repoStatus').textContent = 'No repository selected';
  else if (repo.error) $('repoStatus').textContent = repo.error;
  else {
    const parts = [`⎇ ${repo.branch}`];
    if (repo.ahead) parts.push(`↑${repo.ahead}`);
    if (repo.behind) parts.push(`↓${repo.behind}`);
    parts.push(repo.changes ? `${repo.changes} changed` : 'clean');
    $('repoStatus').textContent = parts.join(' · ');
  }
}

function renderRepoMenu() {
  const menu = $('repoMenu');
  menu.replaceChildren();
  for (const dir of state.repos || []) {
    const b = el('button', null, dir.replace(/^\/Users\/[^/]+/, '~'));
    b.onclick = async () => {
      menu.classList.add('hidden');
      const info = await rev.selectRepo(dir);
      afterRepoChange(info);
    };
    menu.appendChild(b);
  }
  if ((state.repos || []).length) menu.appendChild(el('div', 'sep'));
  const pick = el('button', null, 'Open Repository…');
  pick.onclick = async () => {
    menu.classList.add('hidden');
    const info = await rev.pickRepo();
    if (info) afterRepoChange(info);
  };
  menu.appendChild(pick);
}

async function afterRepoChange(info) {
  if (info?.error) return addMsg('err', `${info.dir}: ${info.error}`);
  const s = await rev.state();
  state.repos = s.repos;
  await refreshRepo(info);
  clearChat();
  if (!$('prs').classList.contains('hidden')) loadPrs();
}

$('repoBtn').onclick = (e) => {
  e.stopPropagation();
  renderRepoMenu();
  $('repoMenu').classList.toggle('hidden');
};
document.addEventListener('click', () => $('repoMenu').classList.add('hidden'));

// ---------- tabs / window ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const v of ['chat', 'prs', 'inbox']) $(v).classList.toggle('hidden', t.dataset.tab !== v);
    if (t.dataset.tab === 'prs') loadPrs();
    if (t.dataset.tab === 'inbox') rev.inboxRefresh();
  };
});
$('hideBtn').onclick = () => rev.hide();

// ---------- Dynamic Island ----------
const island = $('island');
let islandState = 'collapsed';
let peekTimer = null;
let unreadCount = 0;
let awaiting = false;

function setIsland(stateName) {
  islandState = stateName;
  island.classList.remove('collapsed', 'peeking', 'expanded');
  island.classList.add(stateName);
  if (stateName === 'expanded') setTimeout(() => $('input').focus(), 200);
}

function renderPill() {
  const r = $('pillRight');
  r.replaceChildren();
  if (awaiting) {
    r.append(el('span', 'pill-dot orange'), el('span', null, 'Approve'));
  } else if (busy) {
    r.append(el('span', 'spinner'));
  } else if (unreadCount) {
    r.append(el('span', 'pill-dot'), el('span', null, unreadCount > 99 ? '99+' : String(unreadCount)));
  }
  island.classList.toggle('busy', busy || awaiting);
}

rev.on('island', (s) => {
  clearTimeout(peekTimer);
  setIsland(s);
});
rev.on('island-busy', () => renderPill());

// ---------- resize ----------
// Drag the little bar at the bottom of the open island: up/down changes height,
// left/right changes width (the island stays centered, so it grows on both sides).
let appSize = null;
function applySize(s) {
  if (!s) return;
  appSize = s;
  island.style.setProperty('--app-width', `${s.w}px`);
  island.style.setProperty('--app-height', `${s.h}px`);
}
rev.on('island-size', applySize);
(() => {
  const grip = $('resizeGrip');
  let start = null;
  const sizeAt = (e) => ({
    w: Math.min(state.maxSize.w, Math.max(state.minSize.w, Math.round(start.w + 2 * (e.screenX - start.x)))),
    h: Math.min(state.maxSize.h, Math.max(state.minSize.h, Math.round(start.h + (e.screenY - start.y)))),
  });
  grip.addEventListener('pointerdown', (e) => {
    if (islandState !== 'expanded' || !appSize) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    start = { x: e.screenX, y: e.screenY, ...appSize };
    island.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    const s = sizeAt(e);
    // Grow the window first so the island never gets clipped, then resize the island.
    rev.islandResize(s, false).then(() => applySize(s));
  });
  const end = (e) => {
    if (!start) return;
    const s = sizeAt(e);
    start = null;
    island.classList.remove('resizing');
    rev.islandResize(s, true).then(applySize);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => rev.islandResize(state.defaultSize, true).then(applySize));
})();

// While collapsed the window lets clicks through everywhere except the island itself.
let overIsland = false;
document.addEventListener('mousemove', (e) => {
  const over = Boolean(e.target.closest && e.target.closest('#island'));
  if (over !== overIsland) {
    overIsland = over;
    rev.islandHover(over);
  }
});
// Clicking anywhere on the closed island opens it (not only the pill's own element,
// which the scaled app layer can sit on top of).
island.addEventListener('click', () => {
  if (islandState === 'collapsed') rev.expand();
});

let peekItem = null;
rev.on('island-peek', (it) => {
  if (!it || islandState === 'expanded') return;
  peekItem = it;
  const [kind, svg] = iconFor(it);
  $('peekIcon').className = `note-icon ${kind}`;
  $('peekIcon').innerHTML = svg;
  $('peekTop').textContent = `${it.reasonLabel} · ${it.repo}`;
  $('peekTitle').textContent = it.title;
  setIsland('peeking');
  clearTimeout(peekTimer);
  const settle = () => {
    if (islandState !== 'peeking') return;
    if (overIsland) peekTimer = setTimeout(settle, 1000);
    else setIsland('collapsed');
  };
  peekTimer = setTimeout(settle, 5000);
});
$('peek').onclick = () => {
  if (peekItem) rev.inboxOpen(peekItem.id);
  setIsland('collapsed');
};

function setPinnedUi(on) {
  state.pinned = on;
  document.body.classList.toggle('pinned', on);
  $('pinBtn').classList.toggle('on', on);
  $('pinBtn').title = on ? 'Pinned: stays on screen. Click to let it tuck away again.' : 'Keep on screen';
  $('pinToggle').checked = on;
}
$('pinBtn').onclick = () => { setPinnedUi(!state.pinned); rev.setPinned(state.pinned); };
$('pinToggle').onchange = (e) => { setPinnedUi(e.target.checked); rev.setPinned(state.pinned); };
$('notifyToggle').onchange = (e) => rev.setNotify(e.target.checked);
rev.on('pinned', setPinnedUi);

// ---------- settings ----------
function renderClaudeSetting() {
  const on = state.claudeAvailable && state.useClaude;
  $('claudeToggle').checked = on;
  $('claudeToggle').disabled = !state.claudeAvailable;
  $('claudeNote').textContent = !state.claudeAvailable
    ? 'Install Claude Code (claude.com/code) and sign in to use your Claude plan instead of an API key.'
    : on
      ? 'Rev runs through Claude Code with your Claude sign-in. No API key needed.'
      : 'Off: Rev uses the API key below.';
  $('keyGroup').classList.toggle('dim', on);
}
$('claudeToggle').onchange = async (e) => {
  const r = await rev.setUseClaude(e.target.checked);
  state.useClaude = e.target.checked;
  state.provider = r.provider;
  renderClaudeSetting();
  clearChat();
};

function openSettings() {
  $('settings').classList.remove('hidden');
  renderClaudeSetting();
  const who = { openrouter: 'OpenRouter', groq: 'Groq' }[state.provider] || 'Anthropic';
  $('keyNote').textContent = state.keyFromEnv
    ? `Using your ${who} key from the environment.`
    : state.hasKey
      ? `${who} key saved, encrypted in ${state.secretStore}.`
      : 'Paste a Groq (gsk_…), OpenRouter (sk-or-…) or Anthropic (sk-ant-…) key. It is stored encrypted in ' + state.secretStore + '.';
  const model = { 'claude-code': 'Claude via your Claude plan', openrouter: 'newest Claude Opus on OpenRouter', groq: 'a tool-calling model on Groq' }[state.provider] || state.model;
  $('about').textContent = `Model: ${model} · Open from anywhere: ${state.shortcut}`;
  $('notifyToggle').checked = state.notify;
  $('pinToggle').checked = state.pinned;
}
$('settingsBtn').onclick = openSettings;
$('closeSettings').onclick = () => $('settings').classList.add('hidden');
$('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); };
$('saveKey').onclick = async () => {
  try {
    const r = await rev.setApiKey($('apiKey').value);
    state.hasKey = r.hasKey;
    state.provider = r.provider;
    $('apiKey').value = '';
    $('settings').classList.add('hidden');
  } catch (e) {
    $('keyNote').textContent = e.message;
  }
};
$('quitBtn').onclick = () => rev.quit();

// ---------- assistant ----------
function clearChat() {
  cmdCards.clear();
  const w = welcome.cloneNode(true);
  if (!state.repo || state.repo.error) w.querySelector('.hint-sub').textContent = 'Choose a repository at the top to get started.';
  $('log').replaceChildren(w);
}

function setBusy(on) {
  busy = on;
  if (typeof renderPill === 'function') renderPill();
  $('sendBtn').classList.toggle('hidden', on);
  $('stopBtn').classList.toggle('hidden', !on);
  $('newChat').classList.toggle('hidden', on);
}

function cmdCard(ev) {
  let card = cmdCards.get(ev.id);
  if (!card) {
    $('log').querySelector('.hint')?.remove();
    card = el('div', 'cmd');
    const head = el('div', 'cmd-head');
    head.append(el('span', 'dot'), el('span', 'c', `$ ${ev.command}`));
    head.onclick = () => card.classList.toggle('collapsed');
    card.append(head);
    $('log').appendChild(card);
    cmdCards.set(ev.id, card);
  }
  card.className = `cmd ${ev.status}`;
  card.querySelector('.confirm')?.remove();

  if (ev.status === 'awaiting') {
    const danger = ev.level === 'danger';
    const box = el('div', `confirm ${danger ? 'danger' : ''}`);
    const icon = el('div', 'icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5 22 20.5H2z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>';
    box.append(icon, el('div', 'why', ev.why), el('div', 'q', 'Do you want to run this command?'));
    const row = el('div', 'row');
    const no = el('button', 'btn', 'Don\u2019t Run');
    const yes = el('button', danger ? 'btn destructive' : 'btn primary', 'Run');
    yes.onclick = () => rev.confirm(ev.id, true);
    no.onclick = () => rev.confirm(ev.id, false);
    row.append(no, yes);
    box.append(row);
    card.append(box);
    yes.focus();
  }
  if (ev.output != null) {
    let pre = card.querySelector('pre');
    if (!pre) card.append((pre = el('pre')));
    pre.textContent = ev.output || '(no output)';
    if (ev.status === 'ok' && ev.output.split('\n').length > 6) card.classList.add('collapsed');
  }
  if (ev.status === 'denied') card.append(el('pre', null, 'You chose not to run this.'));
  scroll();
}

rev.on('agent-event', (ev) => {
  if (ev.type === 'text') addMsg('ai', ev.text);
  else if (ev.type === 'cmd') {
    cmdCard(ev);
    awaiting = ev.status === 'awaiting';
    renderPill();
  }
  else if (ev.type === 'error') addMsg('err', ev.text);
  else if (ev.type === 'done') {
    setBusy(false);
    refreshRepo();
    $('input').focus();
  }
});
rev.on('chat-reset', clearChat);

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  if (!state.hasKey && !(state.claudeAvailable && state.useClaude)) return openSettings();
  addMsg('user', text);
  $('input').value = '';
  $('input').style.height = 'auto';
  setBusy(true);
  await rev.send(text);
}

$('composer').onsubmit = (e) => {
  e.preventDefault();
  send($('input').value);
};
$('input').addEventListener('input', () => {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send($('input').value);
  }
});
$('stopBtn').onclick = () => rev.cancel();
$('newChat').onclick = async () => {
  await rev.reset();
  clearChat();
};
$('log').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c) {
    if (c.textContent.endsWith('/')) {
      $('input').value = c.textContent;
      $('input').focus();
    } else send(c.dataset.prompt || c.textContent);
  }
});

// ---------- pull requests ----------
function toast(ok, text) {
  document.querySelector('.toast')?.remove();
  const t = el('div', `toast ${ok ? 'ok' : 'bad'}`, text);
  $('prList').before(t);
  setTimeout(() => t.remove(), 6000);
}

function reviewBadge(d) {
  if (d === 'APPROVED') return el('span', 'badge ok', 'Approved');
  if (d === 'CHANGES_REQUESTED') return el('span', 'badge bad', 'Changes requested');
  if (d === 'REVIEW_REQUIRED') return el('span', 'badge warn', 'Review required');
  return null;
}
function checksBadge(c) {
  if (!c || c.state === 'none') return null;
  if (c.state === 'pass') return el('span', 'badge ok', `Checks passed`);
  if (c.state === 'fail') return el('span', 'badge bad', `${c.fail} check${c.fail > 1 ? 's' : ''} failing`);
  return el('span', 'badge warn', `${c.pending} check${c.pending > 1 ? 's' : ''} running`);
}

function prRow(p, { local }) {
  const box = el('div', 'pr');
  const title = el('div', 'pr-title', p.title);
  title.onclick = () => rev.prOpen(p.url);
  const meta = el('div', 'pr-meta');
  const repoName = p.repository?.nameWithOwner || '';
  meta.append(el('span', null, `${repoName}#${p.number}`));
  if (p.headRefName) meta.append(el('span', null, `${p.headRefName} → ${p.baseRefName}`));
  if (p.author?.login) meta.append(el('span', null, `@${p.author.login}`));
  if (p.isDraft) meta.append(el('span', 'badge', 'Draft'));
  [reviewBadge(p.reviewDecision), checksBadge(p.checks)].forEach((b) => b && meta.append(b));
  if (p.mergeable === 'CONFLICTING') meta.append(el('span', 'badge bad', 'Conflicts'));

  const actions = el('div', 'pr-actions');
  const open = el('button', 'btn small', 'Open');
  open.onclick = () => rev.prOpen(p.url);
  actions.append(open);
  if (local) {
    const co = el('button', 'btn small', 'Check Out');
    co.onclick = async () => {
      const r = await rev.prCheckout(p.number);
      toast(r.code === 0, r.code === 0 ? `Checked out #${p.number}` : r.stderr || r.stdout);
      refreshRepo();
    };
    actions.append(co);
  }
  const ask = el('button', 'btn small', 'Ask Rev');
  ask.title = 'Send this PR to the Assistant';
  ask.onclick = () => {
    document.querySelector('.tab[data-tab="chat"]').click();
    $('input').value = `PR ${repoName}#${p.number}: `;
    $('input').focus();
  };
  actions.append(ask);
  // Only show Merge where you're allowed to merge (write, maintain or admin access).
  if (!p.isDraft && p.canMerge) {
    const method = el('select');
    ['squash', 'merge', 'rebase'].forEach((m) => method.append(new Option(m, m)));
    const merge = el('button', 'btn small primary', 'Merge');
    merge.onclick = async () => {
      const r = await rev.prMerge({ repo: repoName, number: p.number, title: p.title, method: method.value, deleteBranch: true });
      if (r.code === -1) return;
      toast(r.code === 0, r.code === 0 ? `Merged #${p.number}` : r.stderr || r.stdout);
      if (r.code === 0) loadPrs();
    };
    actions.append(method, merge);
  }
  box.append(title, meta, actions);
  return box;
}

function section(title, list, opts) {
  const s = el('div', 'pr-section');
  s.append(el('h4', null, list.length ? `${title} · ${list.length}` : title));
  const g = el('div', 'group');
  if (!list.length) g.append(el('div', 'empty', 'No pull requests'));
  list.forEach((p) => g.append(prRow(p, opts)));
  s.append(g);
  return s;
}

async function loadPrs() {
  const list = $('prList');
  list.replaceChildren(el('div', 'empty', 'Loading…'));
  const data = await rev.prsLoad();
  list.replaceChildren();
  data.errors.forEach((e) => list.append(el('div', 'toast bad', e)));
  if (state.repo && !state.repo.error) list.append(section(`Open in ${state.repo.name}`, data.repo, { local: true }));
  list.append(section('My Open Pull Requests', data.mine, { local: false }));
  list.append(section('Waiting for My Review', data.review, { local: false }));
}

$('prRefresh').onclick = loadPrs;
$('prNewToggle').onclick = () => $('prForm').classList.toggle('hidden');
$('prForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await rev.prCreate({
    title: $('prTitle').value,
    body: $('prBody').value,
    base: $('prBase').value.trim(),
    draft: $('prDraft').checked,
  });
  toast(r.code === 0, r.code === 0 ? `Created: ${r.stdout.trim()}` : r.stderr || r.stdout);
  if (r.code === 0) {
    $('prForm').reset();
    $('prForm').classList.add('hidden');
    loadPrs();
  }
};

// ---------- GitHub inbox ----------
const ICONS = {
  pr: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2"/></svg>',
  issue: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  ci: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7"/></svg>',
  mention: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>',
};
const check = '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7"/></svg>';

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function iconFor(it) {
  if (it.reason === 'review_requested' || it.reason === 'approval_requested') return ['review', ICONS.pr];
  if (it.reason === 'mention' || it.reason === 'team_mention') return ['mention', ICONS.mention];
  if (it.reason === 'ci_activity' || it.type === 'CheckSuite') return ['ci', ICONS.ci];
  if (it.reason === 'state_change') return ['state', ICONS.pr];
  if (it.type === 'PullRequest') return ['', ICONS.pr];
  if (it.type === 'Issue') return ['', ICONS.issue];
  return ['', ICONS.bell];
}

function renderInbox({ items = [], error = null } = {}) {
  const unread = items.filter((i) => i.unread);
  unreadCount = unread.length;
  renderPill();
  $('inboxBadge').textContent = unread.length > 99 ? '99+' : String(unread.length);
  $('inboxBadge').classList.toggle('hidden', !unread.length);
  const list = $('inboxList');
  list.replaceChildren();
  if (error) list.append(el('div', 'toast bad', error));
  if (!unread.length) {
    const e = el('div', 'inbox-empty');
    const ic = el('div');
    ic.innerHTML = check;
    e.append(ic, el('div', 'big', 'You\u2019re all caught up'), el('div', 'small', 'New reviews, mentions, comments and CI results will show up here and as desktop notifications.'));
    if (!error) list.append(e);
    return;
  }
  const g = el('div', 'group');
  for (const it of unread) {
    const row = el('div', 'note-row');
    const [kind, svg] = iconFor(it);
    const icon = el('div', `note-icon ${kind}`);
    icon.innerHTML = svg;
    const main = el('div', 'note-main');
    const top = el('div', 'note-top');
    top.append(el('span', null, it.reasonLabel), el('span', 'when', ago(it.updatedAt)));
    const title = el('div', 'note-title', it.title);
    title.onclick = () => rev.inboxOpen(it.id);
    main.append(top, title, el('div', 'note-repo', it.repo));
    const done = el('button', 'done');
    done.title = 'Mark as read';
    done.innerHTML = check;
    done.onclick = () => rev.inboxRead(it.id);
    row.append(icon, main, done);
    g.append(row);
  }
  list.append(g);
}

rev.on('inbox', renderInbox);
$('inboxRefresh').onclick = () => rev.inboxRefresh();
$('inboxReadAll').onclick = () => rev.inboxReadAll();

// ---------- boot ----------
(async () => {
  state = await rev.state();
  // plat-darwin / plat-win32 / plat-linux: styles.css floats the island as a pill off the Mac.
  document.body.classList.add(`plat-${state.platform}`);
  $('pill').title = `Open Rev (${state.shortcut})`;
  applySize(state.islandSize);
  setPinnedUi(state.pinned);
  await refreshRepo(state.repo);
  renderInbox(await rev.inboxLoad());
  if (!state.hasKey && !(state.claudeAvailable && state.useClaude)) openSettings();
  $('input').focus();
})();
