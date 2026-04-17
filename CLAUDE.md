# Stash

This project implements the specification in docs/SPEC.md.
Read that document before doing anything.

Stack: Wails + Go + Tiptap + TypeScript + React + shadcn/ui
Current milestone: Milestone 9 (Ask & Explain Gestures)

## Key architectural notes

- Build with `-tags webkit2_41` (handled transparently by shell.nix / `wails dev`)
- Frontmatter is stripped before passing to Tiptap (`splitFrontmatter` in App.tsx), re-prepended on save
- `H.current` is the stable handler ref, updated via `useLayoutEffect` (not `useEffect`) so keydown always sees current handlers
- `tabsRef`/`activeIdxRef`/`tierRef` are synced each render so async callbacks read latest state without stale closures
- Code block paste uses `queueMicrotask` to defer `insertContent` past React render (avoids flushSync warning)
- `user_intent` is exclusively the user's field — AI must never write to it

## CLI integration

- `store/cli.go` `RunCLI` passes prompt via **stdin** to `claude --print --no-session-persistence`
- Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get interpreted as shell command substitution and the content is silently erased
- Timeout default: 20s (configurable via `cli_timeout` in settings.json)
