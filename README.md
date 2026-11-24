# Rev AI

A small always-on-top window for your Mac that runs git and GitHub tasks from plain-English prompts, plus a separate pull request manager.

## Setup

You need Node 20+, git, and the GitHub CLI:

```sh
brew install gh      # if you don't have it
gh auth login        # Rev uses your gh sign-in for everything GitHub
cd ~/code/rev-ai
npm install
npm start
```

**Easiest: use your Claude plan.** If Claude Code is installed and signed in (`claude` in Terminal, then sign in with your Claude account), Rev uses it automatically, with no API key. Rev runs `claude -p` with no built-in tools. Its only tools are Rev's `git` and `gh`, served from a small local MCP server inside Rev, so risky commands still wait for your Approve. Usage counts against your Claude plan. Turn it off in Settings (⚙) → "Use my Claude plan" to use an API key instead.

Otherwise, open Settings (⚙) and paste an API key. It is stored encrypted in your macOS keychain, never in a file.

- A **Groq** key (`gsk_…`) makes Rev use Groq's OpenAI-compatible API with a strong tool-calling model it offers (`openai/gpt-oss-120b` when available; override with `REV_GROQ_MODEL`).
- An **OpenRouter** key (`sk-or-…`) makes Rev call Claude through OpenRouter's Anthropic-compatible API. It picks the newest Claude Opus that OpenRouter lists (override with `REV_OPENROUTER_MODEL`).
- An **Anthropic** key (`sk-ant-…`) calls the Claude API directly with `claude-opus-5-5`.
- With no saved key, `GROQ_API_KEY`, `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` from the environment is used.

To build a standalone app: `npm run dist` (creates a .dmg in `dist/`).

## Using it

- Rev lives at the top center of your screen as a small black **island** around the notch. Click it (or press **⌘⇧Space**) and it morphs open into the full app; click anywhere else and it shrinks back. Pin 📌 keeps it open.
- When new GitHub notifications arrive, the island peeks out with the newest one; click it to open on GitHub. While the assistant works, the island shows a spinner, and an orange "Approve" when a command is waiting for you.
- The ◇ menu bar icon shows your unread GitHub count; right-click it for options and Quit.
- Click the repo chip to pick a repository (recent ones are remembered). Switching repos starts a fresh conversation.

### Changing the size and look yourself

- **Drag to resize:** open the island and drag the small bar at its bottom. Up/down changes the height, left/right the width. Rev remembers the size. Double-click the bar (or right-click ◇ → Reset Size) to go back to 340×470.
- **Edit the design by hand:** open `src/renderer/styles.css` and find the block marked **★ Design knobs**. Change `--app-width`, `--app-height`, `--text-size`, `--corner` or `--accent`, then quit Rev (right-click ◇ → Quit) and run `npm start` again. A size you dragged is saved in settings and wins over `--app-width`/`--app-height`; use Reset Size first if you want the CSS values. The default size used by Reset Size is `DEFAULT_SIZE` in `src/main.js`.

### The logo

Rev uses one logo everywhere: the island pill, the welcome screen, Settings, the menu bar, desktop notifications and the app icon.

- `assets/logo.svg` is the blue mark, and `assets/logo-mark.svg` is the same mark in `currentColor` for use on any background.
- `assets/app-icon.svg` is the rounded macOS app icon.
- `assets/*.png` are ready-made sizes (app icon 16 to 1024 px, logo 64 to 512 px). Other apps, like a widget, can reuse them.

To change the logo, edit the SVGs and run `npm run icons`. That redraws every PNG, `src/assets/icon.png` (used for notifications) and `build/icon.icns` (used by `npm run dist`). The menu bar icon is `src/assets/trayTemplate.png`.

### Assistant tab

Type what you want: "pull the latest", "commit my changes with a good message and push", "create a branch called fix/login from main", "rebase on main", "open a PR for this branch", "why did my push get rejected?". Each command Claude runs shows up as a card with its output.

Commands that can lose work or affect other people pause for **Approve / Deny**:

| Asks first (red) | Asks first (amber) | Never allowed |
| --- | --- | --- |
| force push, push --delete, rebase, reset --hard, clean, branch -D, checkout -- ., restore, stash drop/clear, filter-branch, gh pr merge/close, gh repo delete, gh api DELETE | push straight to main/master/develop, commit --amend, branch -d, reset, tag -d, gh pr create/comment/review/edit, gh api POST/PATCH | interactive flags (-i), gh auth (except status), gh secret / ssh-key / gpg-key changes |

Rules live in `src/risk.js`, with tests in `test/risk.test.js`.

### Pull requests tab

Three lists: open PRs in the current repo (with review state, checks and conflicts), your open PRs across GitHub, and PRs waiting for your review. Each PR can be opened in the browser, checked out, sent to the Assistant ("Ask AI"), or merged (squash/merge/rebase, with a confirmation). The Merge button only appears on PRs in repositories where you have write, maintain or admin access. **＋ New PR** creates a PR from your current branch.

## How it works

- `src/main.js`: Electron main process: the floating window, global shortcut, tray, settings, IPC.
- `src/claudecode.js`: the "Use my Claude plan" path: runs the Claude Code CLI and serves Rev's git/gh tools to it over local MCP.
- `src/agent.js`: Claude (`claude-opus-5-5`) with two tools, `git` and `gh`. It uses the Anthropic SDK tool runner; each tool call runs one command with `execFile` (no shell) in the selected repo. Server-side refusal fallback is on.
- `src/risk.js`: decides which commands need approval.
- `src/prs.js`: PR manager on top of `gh`.
- `src/renderer/`: the UI.

Run tests with `npm test`.
