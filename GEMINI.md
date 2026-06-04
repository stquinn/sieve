# Stash Project Rules (Gemini/Antigravity)

This file contains project-specific instructions and patterns for Gemini/Antigravity.

## Build and Development Commands

All compilation should happen inside the Nix shell to ensure the correct environment (Go version, Node version, and Webkit tags).

- **Frontend Build**: `nix-shell --command "cd frontend && npm run build"`
- **Frontend Typecheck**: `nix-shell --command "cd frontend && npx tsc"`
- **Go Build**: `nix-shell --command "go build -tags webkit2_41"`
- **Wails Dev**: `nix-shell --command "wails dev"`

## Keyboard Shortcut Policy

- **Modifier Key**: Always use the `isMod(e)` helper from `frontend/src/utils/platform.ts`. 
  - Resolves to `Cmd` on macOS and `Ctrl` elsewhere.
- **Save Action**: `Mod + S` is for local persistence ONLY.
- **Smart Filing**: `Mod + Shift + E` triggers AI analysis and potential auto-filing.
- **Explain**: `Mod + E` (overrides Tiptap's default code shortcut).
- **Ask AI**: `Mod + Shift + A`.
- **Toggle AI Visibility**: `Mod + J` (per-editor).

## Architectural Patterns

- **Stable Handlers**: Use the `handlers` ref pattern in `App.tsx` for global shortcuts.
- **AI Context**: Build context using the `buildAiContext` utility to ensure block-chaining persistence.
- **Frontmatter**: Frontmatter must be handled via `splitFrontmatter` to avoid Tiptap corruption.

## Agent Behavior Policies

- **File Editing**: You MUST use native file editing tools (`replace_file_content`, `multi_replace_file_content`) to modify code. NEVER write custom Python, Bash, or ad-hoc scripts (e.g., using `cat << EOF > script.py`) to perform search-and-replace via the terminal. Executing arbitrary scripts triggers security prompts and blocks automation.
