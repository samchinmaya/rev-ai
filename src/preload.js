const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rev', {
  state: () => ipcRenderer.invoke('state'),
  setApiKey: (k) => ipcRenderer.invoke('set-api-key', k),
  pickRepo: () => ipcRenderer.invoke('pick-repo'),
  selectRepo: (d) => ipcRenderer.invoke('select-repo', d),
  repoInfo: () => ipcRenderer.invoke('repo-info'),
  send: (p) => ipcRenderer.invoke('agent-send', p),
  confirm: (id, ok) => ipcRenderer.invoke('agent-confirm', id, ok),
  cancel: () => ipcRenderer.invoke('agent-cancel'),
  reset: () => ipcRenderer.invoke('agent-reset'),
  prsLoad: () => ipcRenderer.invoke('prs-load'),
  prOpen: (u) => ipcRenderer.invoke('pr-open', u),
  prCheckout: (n) => ipcRenderer.invoke('pr-checkout', n),
  prMerge: (o) => ipcRenderer.invoke('pr-merge', o),
  prCreate: (f) => ipcRenderer.invoke('pr-create', f),
  setPinned: (on) => ipcRenderer.invoke('set-pinned', on),
  setNotify: (on) => ipcRenderer.invoke('set-notify', on),
  setUseClaude: (on) => ipcRenderer.invoke('set-use-claude', on),
  inboxLoad: () => ipcRenderer.invoke('inbox-load'),
  inboxRefresh: () => ipcRenderer.invoke('inbox-refresh'),
  inboxOpen: (id) => ipcRenderer.invoke('inbox-open', id),
  inboxRead: (id) => ipcRenderer.invoke('inbox-read', id),
  inboxReadAll: () => ipcRenderer.invoke('inbox-read-all'),
  hide: () => ipcRenderer.invoke('hide'),
  expand: () => ipcRenderer.invoke('expand'),
  islandHover: (over) => ipcRenderer.invoke('island-hover', over),
  islandResize: (size, save) => ipcRenderer.invoke('island-resize', size, save),
  quit: () => ipcRenderer.invoke('quit'),
  on: (channel, fn) => {
    const allowed = ['agent-event', 'chat-reset', 'island', 'island-peek', 'island-busy', 'pinned', 'inbox', 'island-size'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
