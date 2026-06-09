All clean. Here's what was done:

  Removed (React deps eliminated from extensions):
  - AiShortcuts.ts: @tiptap/react → @tiptap/core (type-only import)
  - BlockNode.tsx: ReactNodeViewRenderer → 15-line vanilla NodeView
  - SieveEditor.ts: deleted entirely

  Built:
  - ui/static/vendor/tiptap.js (736KB) — one-time esbuild bundle of TipTap + all extensions, no React, committed to repo
  - ui/static/editor.js — plain vanilla JS, ~280 lines, loaded once at startup

  Architecture:
  - Tab switch → loadEditor(uuid, mode) → htmx.ajax GET /api/editor → Go renders editor.html (#tiptap-mount div) → htmx:afterSettle → window.sieveInitEditor(mountEl, uuid, mode) → editor.js fetches body from
  /api/editor/load, initializes TipTap
  - Autosave: POST /api/editor/save directly from JS
  - AI: accesses window.__sieveAiService (the same React AiService instance, exposed from App.tsx)

  Next time extensions are rewritten as plain JS, they move from the bundle entry into editor.js directly — shrinking the bundle until it's just TipTap core, which can then be swapped for a pre-built package file
  and esbuild disappears.

✻ Sautéed for 9m 23s

※ recap: Migrating the app from React/Vite to HTMX/Go with a plain JS TipTap editor island. Phase 5 is implemented and compiling clean — next step is to run the app and test that the editor loads content correctly.
  (disable recaps in /config)