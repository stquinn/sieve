# LookAndFeel — user-overridable typography

**Status:** Implemented
**Tracked:** #62
**Date:** 2026-07-27

## Problem

Themes supply `editorFont`/`monoFont`/`uiFont` but no size/scale/measure
control, and every size in the editor is a hardcoded literal (`.tiptap`'s
16px/1.75, ~100 more across block renderers). A user who wants larger text —
the most common accessibility/preference request — has no lever, and even if
one existed, most of the document (code, log, diagram source, badges) would
stay pinned while prose moved, which reads as broken.

## Decision

Three-layer precedence, lowest to highest:

1. **CSS default** — `var(--theme-x, <hardcoded fallback>)` in the stylesheet.
2. **Theme JSON** — unedited by this work; themes may adopt size keys later
   with zero pipeline changes (see "Why field names mirror theme-var names").
3. **User `LookAndFeel` override** (`sieve/domain/settings.go`) — wins when set.

`LookAndFeel` fields: `EditorFont`, `MonoFont`, `UIFont`, `EditorScale`,
`EditorLineHeight`, `EditorMeasure`. Every field is three-state — empty means
"follow the theme" — never pre-filled with the active theme's resolved value.

## Architecture

**Merge is a map overlay, not per-field mapping.** `LookAndFeel.Overrides()`
returns `theme-var-name -> value` for whatever is set and valid; `main.go`'s
`serveThemeCSS` overlays it onto the theme's own `map[string]string` before
emitting `--theme-<key>` custom properties — one loop, no per-key branching.
Field names are chosen to equal the theme-var name they override
(`EditorScale` -> `editorScale`) specifically so this stays true: a future
override key is a struct field plus one line in `Overrides()`, nothing else
in the pipeline (main.go, the CSS, the settings handler all already iterate
generically).

**Sizes are CSS value strings, not typed numbers.** `EditorMeasure` is `"72ch"`,
`EditorLineHeight` is `"1.75"` (unitless) — different units and no unit at
all. A typed `int`/`float64` field would need a per-field "add its unit back"
step at the one place all the others are unit-agnostic; a string keeps one
handling path (validate the whole string against a pattern, emit verbatim)
uniform across every field, including future ones with yet another unit.

**Editor size is a stepped multiplier, not an absolute size.** `EditorScale`
is a unitless multiplier over a `calc()` base
(`--doc-size: calc(var(--theme-editorBaseSize, 16px) * var(--theme-editorScale, 1))`,
defined on `.editor-panel`, the shared ancestor of both the WYSIWYG (`.tiptap`)
and raw-markdown (`MarkdownSurface`) input surfaces — not on `.tiptap` itself,
because markdown mode swaps `.tiptap` out for a sibling, never nesting inside
it, so a `.tiptap`-scoped definition would silently stop applying there).
Users think in steps ("a bit bigger"), matching macOS Display settings/browser
zoom/VS Code, not px. The allowed set — `0.85, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75,
2.0` — is closed (validated by exact membership, not a numeric range) so a
hand-edited settings.json cannot persist an illegal intermediate value.

A multiplier also composes correctly with the other two size fields for free:
`ch` (measure) is font-relative, so a 72ch line width tracks the scale
automatically without being expressed in px; unitless line-height is already
scale-free. One number moves the whole document coherently.

**Every editor-internal font-size expresses itself as `calc(var(--doc-size) *
<tier>)`, referencing the root directly rather than a parent's computed
size.** `em` compounds — a 0.85em code block containing a nested 0.75em badge
yields 0.64em of the document size two levels down, worse at deeper nesting —
so this is `rem` semantics scoped to the editor (`html` is not the thing being
scaled) rather than `em`. Four tiers cover every non-prose role: `1` (raw-mode
source, treated as body-equivalent), `0.85` (code/log/diagram source —
mono is optically smaller at equal size, a ratio the codebase already used),
`0.75` (secondary/meta text — chips, status text, small captions), `0.7`
(smallest chrome — badges, gutter numbers, toggle-pill labels). Prose body
text (paragraphs/lists/blockquote — no explicit font-size, inherits
`--doc-size` directly) and headings (`em` against `.tiptap` directly, single
level, already non-compounding) were left untouched — they are not chrome and
carry no compounding risk. Gutter/content pairs that must stay row-aligned
(code block gutter vs its source, the raw-mode line-number column vs the
textarea) are pinned to the SAME tier deliberately: line alignment depends on
identical `font-size * line-height`, so shrinking a gutter to a smaller tier
than its paired text would drift the numbers off their lines the moment
`editorScale != 1`.

**Validation lives in `Overrides()`, not only on save.** The settings UI is
dropdowns/number inputs and cannot inject, but these values are written
VERBATIM into a served stylesheet (`/theme.css`) and `settings.json` is
hand-editable — a value containing `;`/`}` would inject arbitrary CSS.
Validating on the way OUT means a hand-edited file degrades to the theme
value instead of reaching the stylesheet; validating only at save time would
leave that path open. Regex patterns are package-level `regexp.MustCompile`
vars (compiled once); the validating behaviour is methods on `LookAndFeel`
(project rule — no loose functions), one per field family plus the numeric
range checks the regexes alone can't express (line-height 1.2-2.4, scale
closed-set membership).

**"Unset" must be a real three-state, never pre-filled with the theme's
resolved value.** The settings UI's "Use theme default" option is first and
selected whenever a field is empty; saving never copies the active theme's
current font/size into the field. Pre-filling would silently pin every user's
typography on first save — a later theme switch would then change colours but
leave fonts/sizes stuck on whatever the old theme happened to have, which is
worse than either pure state (always-theme or always-overridden).

**Menu accelerators persist through the normal settings path.** `View >
Increase/Decrease/Reset Editor Font` (`Mod+=`/`Mod+-`/`Mod+0`) call
`POST /api/settings/editor-scale/step?dir=...`, which steps
`LookAndFeel.StepEditorScale` and calls `SaveSettings` — not a transient
client-side zoom — then reuses the existing `HX-Trigger: settings:changed`
mechanism the settings-panel save already fires to bust `/theme.css`'s cache
(`index.html`'s listener reloads the stylesheet link), so the change is both
durable and immediately visible. `docs/editor-interaction-contract.md` is
NORMATIVE that the native menu is the sole owner of app-level chords; these
three rows are it.

## Known ceiling (tracked follow-up)

- **Mermaid's SVG-internal `fontSize` theme variable** (`DiagramTheme.buildMermaidInit`)
  is a JS-side mermaid config value baked into the rendered SVG at draw time,
  not a CSS declaration — it does not track `editorScale`. The diagram
  block's CHROME (badge, toggle pill, gutter, edit-mode source) scales; the
  rendered diagram's own labels do not. Reading `--doc-size` at render time
  and reflowing mermaid's layout is a real behaviour change (mermaid sizes
  boxes around its text), not a drop-in constant swap — deferred.
- **Decorative icon glyphs** (`.block-chrome-handle`'s drag icon,
  `.diagram-block__engine-wrap`'s `▾` chevron) are left at their fixed px —
  the sweep covers text content whose size communicates document scale, not
  UI affordance glyphs.
- **Chrome outside the editor** (toolbar, tabs, sidebar, status bar, settings
  dialog, command popup, search overlay) is deliberately untouched — a
  separate, deferred whole-UI-scaling project with real layout fragility
  (fixed 28px sidebar rows, 44px tab bar) that this work does not take on.
