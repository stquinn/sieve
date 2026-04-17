# Stash

A lightweight, portable, cross-platform scratchpad that bridges the gap between a code editor and a notes app. Zero-friction WYSIWYG markdown editing at its simplest. A persistent AI conversation surface at its most powerful.

## What it is

Stash is a tabbed markdown scratchpad with local store storage. You paste code, jot ideas, capture snippets — then Stash handles the rest. In its smarter modes it files, tags, names, summarises, and answers questions about your content using whatever AI CLI you already have configured.

No API keys in the app. No cloud dependency. No account. Just a binary, a store folder, and your existing CLI toolchain.

## Tiers

Stash has three capability tiers, controlled entirely by `settings.json`. No reinstall or migration required to move between them.

| Tier | Config | What you get |
|------|--------|--------------|
| **Dumb** | No CLI | WYSIWYG markdown editor, tab management, local storage, smart paste detection |
| **Smart** | CLI configured | Everything above + AI filing, folder suggestions, Explain gesture, Ask gesture |
| **Unbounded** | CLI + MCP/agents | Ask gesture inherits whatever the CLI can reach — filesystem, APIs, smart home, anything |

## Key features

- **WYSIWYG markdown** — Tiptap editor, renders as you type
- **Persistent tabs** — session restores on relaunch; unsaved buffers survive crashes
- **Smart paste** — detects code language and wraps in a fenced block automatically
- **AI filing** — when you close a tab, the AI evaluates, names, tags, summarises, and files the note into the store
- **Explain (Ctrl+E)** — asks the AI to explain the current selection, code block, or document inline
- **Ask (Ctrl+Shift+A)** — floating prompt attached to the current context; threads follow-up questions
- **AI blocks** — responses appear inline as styled blockquotes, persisted to markdown, round-trip safe
- **Store structure** — `notes/` shared across devices, `{hostname}/` strictly local; sync is your responsibility
- **CLI-agnostic** — works with Claude, Gemini, GitHub Copilot, or any custom CLI

## Data safety

Stash never discards content in Smart mode without a conscious decision from the AI or the user. Every unsaved buffer is continuously written to disk. Crashes, timeouts, and unreachable CLIs all resolve to the buffer staying open — never to data loss.

## Stack

- **Go + Wails v2** — single native binary, no installer, no daemon
- **React + TypeScript** — frontend via Wails webview
- **Tiptap** — ProseMirror-based WYSIWYG markdown editor
- **shadcn/ui + Tailwind** — component library and styling

## Store structure

```
store/
├── notes/                    # shared across all devices (sync this)
│   └── topic/
│       └── filed-note.md
├── assets/                   # shared filed note assets
└── {hostname}/               # strictly local to this machine
    ├── settings.json
    ├── session.json
    ├── prompts/
    └── buffers/
```

Point different machines at the same synced store folder. Each host keeps its own settings, session, and buffers without conflicting with others.

## Getting started

```bash
# Launch with a store path
stash /path/to/your/store

# Or launch from within a store directory
cd /path/to/your/store && stash
```

On first launch in a new store, Stash creates the required directory structure and a default `settings.json` for your hostname.

## Settings

Settings live at `store/{hostname}/settings.json`:

```json
{
  "cli": "claude",
  "cli_timeout": 20
}
```

| Field | Description |
|-------|-------------|
| `cli` | Path or name of the AI CLI (`claude`, `gemini`, `gh`, or a custom binary) |
| `cli_timeout` | Seconds before a CLI call is abandoned (default: 20) |

Leave `cli` empty or unset to run in Dumb mode.

## Building

### NixOS / Nix (recommended)

```bash
nix-shell          # enters the dev environment with all dependencies
wails dev          # dev server with hot reload
wails build        # production binary → build/bin/stash
```

The `shell.nix` handles WebKitGTK 4.1 and the `-tags webkit2_41` flag automatically.

### Other Linux

Requirements: Go 1.23+, Node 22+, Wails v2, WebKitGTK 4.1, GTK 3, pkg-config.

```bash
wails dev -tags webkit2_41
wails build -tags webkit2_41
```

### macOS

```bash
wails dev
wails build
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+E` | Explain (selection / code block / document) |
| `Ctrl+Shift+A` | Ask question in context |
| `Ctrl+Shift+E` | Force AI re-evaluation of current note |
| `Ctrl+M` | Toggle markdown / editor mode |
| `Ctrl+F` | Search store |
| `Ctrl+?` | Help |

## CLI integration

Stash passes prompts to the configured CLI via stdin — never via shell argument interpolation. This is safe for content containing backticks, angle brackets, and fenced code blocks.

Supported CLIs and how they are invoked:

| CLI | Invocation |
|-----|-----------|
| `claude` | `claude --print --no-session-persistence` (stdin) |
| `gemini` | `gemini --prompt "" --yolo` (stdin) |
| `gh copilot` | `gh copilot explain` |
| Custom | Stdin only |
