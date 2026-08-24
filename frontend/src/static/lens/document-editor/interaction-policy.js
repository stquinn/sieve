// interaction-policy.js — ONE shared mechanism for keyboard interaction.
// Renderers DECLARE an interactionPolicy; this module resolves the caret's
// context and applies the policy. Per-renderer key handlers are forbidden
// (docs/editor-interaction-contract.md is the normative behaviour spec).
//
// Layered: pure helpers (top section, vitest-tested) + the TipTap extension
// (browser-only, added by editor.js at priority 50 so native keymaps —
// list indent, table cell nav — always run first: defer first, consume last).
//
// Links split cleanly along that line: the Mod+K CHORD (edit the link at the
// caret / make one from the selection) IS owned here like every other chord —
// the mark mechanics live on ProseLink, this module only routes. Mod+CLICK is
// not, for the reason below.
//
// NOT OWNED HERE — Mod+Click on a link (open externally). It is the one
// interaction that is deliberately APP-GLOBAL rather than editor-scoped: links
// appear outside the editor too (chrome, dialogs, block renderers), and in a Wails
// webview an anchor that navigates replaces the running application, so the
// suppression has to be unconditional. The owner is `shell/workspace.js`
// bootEditorLifecycle() — a document-level CAPTURE-phase click listener. Because
// capture on `document` runs before anything on `view.dom` and it calls
// stopPropagation(), no editor- or renderer-level click handler can see a
// Mod+Click; one added here would be dead code (a PM-level handler was verified
// unreachable and deleted, #67, 2026-07-27). This is an exception to "no
// per-renderer handlers" only in WHERE it lives — it is still exactly ONE shared
// mechanism, just one scoped to the app instead of the editor.
// Normative row: docs/editor-interaction-contract.md.

import { getBlockBehaviour } from '../../renderers/block-kinds.js'
import { expandBlock } from '../../ui/media-lightbox.js'
import { MODE } from '../../contract/sieve-block.js'
import { sieveBlockFor } from './surfaces/sieve-block-extension.js'
import { ProseLink } from './surfaces/prose-link.js'

/** @typedef {import('../../contract/sieve-block.js').SieveBlock} SieveBlock */

/**
 * The full set of behaviours a kind may opt into. Kinds declare a Partial of
 * this as `interactionPolicy`; policyFor merges it over DEFAULT_POLICY.
 * @typedef {object} InteractionPolicy
 * @property {boolean} tabIndents
 * @property {number} indentWidth
 * @property {boolean} smartHome
 * @property {boolean} enterInsertsNewline
 * @property {boolean} autoIndentOnEnter
 * @property {boolean} modEnterTogglesMode
 * @property {boolean} readOnlyText
 * @property {boolean|'render'} caretStop
 * @property {boolean} expandable
 * @property {boolean} surroundSelection
 * @property {boolean} autoClosePairs
 * @property {boolean} expandPairOnEnter
 * @property {boolean} blockTextSubstitution
 * @property {boolean} literalGlyphs
 * @property {boolean} suppressTriggers
 */

// EVERY field is a DISCRETE BEHAVIOUR a kind opts into by name. There is
// deliberately NO genre/text-type field ('code' vs 'prose'): a category is a
// second declaration mechanism next to these flags, and it lies the moment one
// kind wants code-style autoclose with prose-style Enter — at which point you
// add override flags on top and have arrived back here with an extra layer of
// indirection. The "yep, this is code" ergonomics live in CODE_TEXT_POLICY
// below, which is a DECLARATION-TIME preset, not a runtime category.
//
// `rawText` used to sit here meaning three things at once ("literal paste
// target; Tab indents inside", plus an unwritten "this is code"). Only the Tab
// half was ever implemented — paste literalness comes from PM's `code: true`,
// not from any policy read — so it was split into the behaviours it actually
// performs (2026-07-29). Flags are born WITH their reader: never declare one
// here before something consumes it, which is how `readOnlyText` drifted into
// a live branch that no real kind switched on (log's declaration had lost it;
// only a test FakeBlock exercised it).
export var DEFAULT_POLICY = {
  tabIndents: false,          // Tab/Shift+Tab indent/de-indent each touched line by indentWidth
  indentWidth: 0,             // spaces per Tab where tabIndents
  smartHome: false,           // Home: 1st press → first non-ws char of the line, 2nd → column 0
  enterInsertsNewline: false,
  autoIndentOnEnter: false,
  modEnterTogglesMode: false, // diagram: Mod+Enter flips edit/render instead of escape
  readOnlyText: false,        // log: caret may enter text, typing is consumed
  caretStop: false,           // read-only block: arrows select it as one stop ('render' = only in render mode)
  expandable: false,          // block declares a getExpandContent → Mod+Alt+E / header / menu
  surroundSelection: false,   // typing a pair character over a selection wraps it instead of replacing
  autoClosePairs: false,      // typing an opener inserts the pair (+ type-over, backspace-deletes-pair)
  expandPairOnEnter: false,   // Enter inside an empty pair → opener / indented blank line / closer
  blockTextSubstitution: false, // cancel OS text substitution (macOS smart dashes/quotes) in this block
  literalGlyphs: false,       // render every character distinctly — no ligature shaping ('--' ≠ '–')
  suppressTriggers: false,    // `@`/`/` pickers never arm in this block's text
}

// CODE_TEXT_POLICY — the "yep, this is code" preset: the whole bundle of
// literal-source-text behaviours under one name, SPREAD AT DECLARATION TIME by
// the kinds that want it (`interactionPolicy: { ...CODE_TEXT_POLICY }`).
//
// Why a preset and not a `genre: 'code'` field: policyFor only ever sees plain
// booleans, so there stays exactly ONE declaration mechanism; a kind can opt
// out of any single line of it by overriding that key after the spread; and
// reading a kind's interactionPolicy still tells you everything it does without
// a lookup table somewhere else.
export var CODE_TEXT_POLICY = Object.freeze({
  tabIndents: true,
  indentWidth: 2,
  smartHome: true,
  enterInsertsNewline: true,
  autoIndentOnEnter: true,
  surroundSelection: true,
  autoClosePairs: true,
  expandPairOnEnter: true,
  blockTextSubstitution: true,
  literalGlyphs: true,
  // `@Override`, `@media`, `@Component` sit at a line start after whitespace, so
  // they satisfy the `@` trigger's boundary rule and would open the picker only
  // to flash shut when the library search comes back dry. One line here covers
  // code AND diagram, both of which spread this preset.
  suppressTriggers: true,
})

// PAIRS — the ONE table every pair behaviour reads (surround, autoclose,
// type-over, backspace-deletes-pair, Enter expansion). Frozen and shared so the
// PM surface and the markdown textarea can never drift apart on what a "pair"
// is. Markdown emphasis (* _) is deliberately absent: Mod+B/Mod+I already own
// bold/italic, and a literal asterisk is common enough that surrounding it
// would fight the user more often than help.
export var PAIRS = Object.freeze({ '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '{': '}' })

var CLOSERS = Object.freeze(Object.keys(PAIRS).reduce(function (acc, open) {
  acc[PAIRS[open]] = open
  return acc
}, {}))

/** The closing character for an opener, or null. @param {string} ch */
export function closerFor(ch) {
  return Object.prototype.hasOwnProperty.call(PAIRS, ch) ? PAIRS[ch] : null
}

/** True when ch closes some pair (note `"`/`'`/`` ` `` both open AND close). @param {string} ch */
export function isCloser(ch) {
  return Object.prototype.hasOwnProperty.call(CLOSERS, ch)
}

// A pair should NOT auto-close when it would strand a closer against text the
// user is about to wrap by hand — VS Code's rule. Typing `(` before `foo` gives
// a lone `(`; before a space, a newline, EOF or a closing bracket it pairs.
function isWordChar(ch) {
  return !!ch && /[\w$]/.test(ch)
}

// Defaults first, then the kind's declared overrides for KNOWN keys only — a
// flag name that is not in DEFAULT_POLICY is silently ignored, so the JSDoc
// typedef on `interactionPolicy` (sieve-block-extension.js) is the only thing
// standing between a typo'd flag and a behaviour that quietly never happens.
/** @param {string} kind @returns {InteractionPolicy} */
export function policyFor(kind) {
  var beh = getBlockBehaviour(kind)
  var declared = (beh && beh.interactionPolicy) || {}
  var merged = Object.assign({}, DEFAULT_POLICY)
  for (var k in declared) if (k in DEFAULT_POLICY) merged[k] = declared[k]
  return merged
}

var LIST_TYPES = { listItem: 1, taskItem: 1 }
var TABLE_TYPES = { table: 1, tableRow: 1, tableCell: 1, tableHeader: 1 }

function kindFromTypeName(name) {
  if (!name) return 'prose'
  if (name.indexOf('sieve-') === 0) return name.slice('sieve-'.length)
  // Native TipTap code blocks share the 'code' interaction policy — the
  // contract's Code row applies to BOTH code surfaces (uniform mechanism).
  if (name === 'codeBlock') return 'code'
  return 'prose'
}

// classifyContext is pure: the extension extracts names from PM state and
// passes them here so this decision table is unit-testable.
export function classifyContext(info) {
  var nodeSel = info.nodeSelectionTypeName || null
  var kind = kindFromTypeName(nodeSel || info.parentTypeName)
  var inList = false
  var inTable = false
  ;(info.ancestorTypeNames || []).forEach(function (n) {
    if (LIST_TYPES[n]) inList = true
    if (TABLE_TYPES[n]) inTable = true
  })
  return {
    kind: kind,
    policy: policyFor(kind),
    inList: inList,
    inTable: inTable,
    isNodeSelection: !!nodeSel,
    mode: info.mode || null, // diagram edit/render
  }
}

// ── raw-text transforms (pure; offsets are within the block's text) ─────────

function lineStartsInRange(text, from, to) {
  var starts = [0]
  for (var i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts.filter(function (s) {
    var end = text.indexOf('\n', s)
    if (end === -1) end = text.length
    return s <= to && end >= from
  })
}

export function indentInsertions(text, from, to, width) {
  var pad = new Array(width + 1).join(' ')
  // Collapsed caret: insert at the caret (VS Code semantics — push text right).
  // Selection: indent every touched line at its start.
  if (from === to) return [{ pos: from, insert: pad }]
  return lineStartsInRange(text, from, to)
    .map(function (s) { return { pos: s, insert: pad } })
    .sort(function (a, b) { return b.pos - a.pos })
}

export function dedentDeletions(text, from, to, width) {
  var out = []
  lineStartsInRange(text, from, to).forEach(function (s) {
    var n = 0
    while (n < width && text[s + n] === ' ') n++
    if (n > 0) out.push({ from: s, to: s + n })
  })
  return out.sort(function (a, b) { return b.from - a.from })
}

export function leadingIndentAt(text, offset) {
  var start = text.lastIndexOf('\n', offset - 1) + 1
  // only whitespace BEFORE the caret on this line counts (caret mid-indent
  // copies what's left of it)
  var m = /^[ \t]*/.exec(text.slice(start, offset))
  return m ? m[0] : ''
}

export function smartHomeTarget(lineText, col) {
  var first = /^[ \t]*/.exec(lineText)[0].length
  return col === first ? 0 : first
}

// ── pair transforms (pure) ─────────────────────────────────────────────────
//
// Every pair behaviour returns the same edit shape, and both surfaces apply it
// the same way — the PM plugin as a transaction, the markdown <textarea> via
// applyTextEdit. That shared shape is the whole reason the rule cannot drift
// between the two surfaces.
//
// OFFSET CAVEAT: block-local offsets are derived from `parent.textContent`,
// which drifts from PM positions in a textblock containing inline ATOMS (a
// hardBreak or inline image contributes 1 to position but 0 to textContent).
// Only the character-peeking guards below (autoClose/typeOver/pairDelete) index
// into `text`, and those run exclusively under `autoClosePairs` — declared only
// by literal-source-text kinds, whose `text*` content cannot hold an atom.
// `surroundEdit`, the one behaviour prose enables, never indexes `text` at all.
//
/**
 * An edit is a list of point operations in DESCENDING position order, so
 * applying them in sequence never invalidates a later one's offsets.
 *
 * Surround is deliberately two INSERTIONS rather than one replacement: in prose
 * the wrapped range carries marks (bold, links), and re-writing it as plain
 * text would silently flatten them. Nothing here ever rewrites existing
 * content — ops only insert around it or delete it outright.
 *
 * @typedef {object} TextOp
 * @property {number} from    start of the replaced range (block-local offsets)
 * @property {number} to      end of the replaced range (== from for an insertion)
 * @property {string} insert  text to put there
 *
 * @typedef {object} TextEdit
 * @property {TextOp[]} ops   applied in the given (descending) order
 * @property {number} caret   resulting selection anchor, in POST-edit offsets
 * @property {number} [head]  resulting selection head; omitted = collapsed at caret
 */

/**
 * Typing a pair character over a NON-EMPTY selection wraps it instead of
 * replacing it. The selection is preserved (now sitting inside the pair) so the
 * gesture can be repeated to nest.
 * @returns {TextEdit|null}
 */
export function surroundEdit(text, from, to, ch) {
  var close = closerFor(ch)
  if (close === null || from === to) return null
  return {
    ops: [
      { from: to, to: to, insert: close },
      { from: from, to: from, insert: ch },
    ],
    caret: from + 1,
    head: to + 1,
  }
}

/**
 * Typing a closer that is already sitting at the caret moves past it rather
 * than inserting a second one. Checked BEFORE autoClose because `"`/`'`/`` ` ``
 * are their own closers.
 * @returns {TextEdit|null}
 */
export function typeOverEdit(text, from, to, ch) {
  if (from !== to || !isCloser(ch) || text[from] !== ch) return null
  return { ops: [], caret: from + 1 } // pure caret move: the closer is already there
}

/**
 * Typing an opener at a collapsed caret inserts the whole pair.
 * @returns {TextEdit|null}
 */
export function autoCloseEdit(text, from, to, ch) {
  var close = closerFor(ch)
  if (close === null || from !== to) return null
  if (isWordChar(text[from])) return null // would strand the closer against a word
  // Symmetric pairs are also apostrophes/primes: `don` + `'` must stay a lone
  // quote, so a quote never opens against a word on its LEFT either.
  if (close === ch && isWordChar(text[from - 1])) return null
  return { ops: [{ from: from, to: from, insert: ch + close }], caret: from + 1 }
}

/**
 * Backspace with the caret between an empty pair removes both halves —
 * without this, autoclose leaves orphaned closers behind and is worse than no
 * autoclose at all.
 * @returns {TextEdit|null}
 */
export function pairDeleteEdit(text, from, to) {
  if (from !== to || from === 0) return null
  var close = closerFor(text[from - 1])
  if (close === null || text[from] !== close) return null
  return { ops: [{ from: from - 1, to: from + 1, insert: '' }], caret: from - 1 }
}

/**
 * Enter with the caret between an empty pair expands to a block: opener line,
 * indented blank line with the caret on it, closer line at the original indent.
 * This is where a brace style like `if x {` ⏎ actually lives.
 * @returns {TextEdit|null}
 */
export function pairExpandEdit(text, from, to, indentWidth) {
  if (pairDeleteEdit(text, from, to) === null) return null // same "between an empty pair" test
  var indent = leadingIndentAt(text, from)
  var pad = new Array(indentWidth + 1).join(' ')
  return {
    ops: [{ from: from, to: from, insert: '\n' + indent + pad + '\n' + indent }],
    caret: from + 1 + indent.length + pad.length,
  }
}

/**
 * THE text-input decision for a typed character — the single entry point both
 * surfaces call. Order matters: surround (there is a selection) → type-over
 * (the closer is already there) → autoclose. Returns null for "not ours, let
 * the surface do its native thing".
 * @param {string} text @param {number} from @param {number} to @param {string} ch
 * @param {InteractionPolicy} policy
 * @returns {TextEdit|null}
 */
export function textInputEdit(text, from, to, ch, policy) {
  if (!ch || ch.length !== 1) return null
  if (from > to) { var t = from; from = to; to = t }
  if (policy.surroundSelection) {
    var wrap = surroundEdit(text, from, to, ch)
    if (wrap) return wrap
  }
  if (policy.autoClosePairs) {
    return typeOverEdit(text, from, to, ch) || autoCloseEdit(text, from, to, ch)
  }
  return null
}

/**
 * Apply an edit to a plain string — used by the markdown <textarea> surface and
 * by the unit tests, so the behaviour under test is literally the shipped one.
 * @param {string} text @param {TextEdit} edit
 * @returns {{text: string, caret: number, head: number}}
 */
export function applyTextEdit(text, edit) {
  var out = text
  edit.ops.forEach(function (op) {
    out = out.slice(0, op.from) + op.insert + out.slice(op.to)
  })
  return { text: out, caret: edit.caret, head: edit.head === undefined ? edit.caret : edit.head }
}

// ── browser layer: PM state → classified context, and the TipTap extension ──

export function resolveContext(state, view) {
  var sel = state.selection
  var nodeSelName = sel.node ? sel.node.type.name : null
  var $from = sel.$from
  var ancestors = []
  var parent = $from.parent
  // Typed block read — the policy never indexes raw attr maps (contract
  // §typed block). Via sieveBlockFor with NO blockService: the mode
  // here is the LIVE presentation mode (diagram edit/render, toggled locally by
  // Mod+Enter), a PM-node concern — never the mirror's Go truth (which would lag
  // the toggle). It resolves through the resurrect path, reading node attrs.
  // MODE.DEFAULT (modeless kinds) normalises to null so classifyContext's
  // ctx.mode contract is unchanged.
  var blockMode = sieveBlockFor(sel.node || parent).mode
  var mode = blockMode === MODE.DEFAULT ? null : blockMode

  // If focus is inside a block sub-element (e.g. log table filter input), resolve that block
  if (view && document.activeElement && view.dom.contains(document.activeElement)) {
    var blockEl = document.activeElement.closest('.sieve-block')
    if (blockEl) {
      try {
        var contentDOM = blockEl.querySelector('code')
        var targetDOM = contentDOM || blockEl
        var pos = view.posAtDOM(targetDOM, 0)
        if (pos !== undefined && pos !== null && pos >= 0) {
          var $pos = view.state.doc.resolve(pos)
          var resolvedNode = $pos.node(1)
          if (resolvedNode) {
            parent = resolvedNode
            ancestors = [resolvedNode.type.name]
            var rm = sieveBlockFor(resolvedNode).mode
            mode = rm === MODE.DEFAULT ? null : rm
          }
        }
      } catch (e) {
        // Fallback to selection-based logic
      }
    }
  }

  if (ancestors.length === 0) {
    for (var d = $from.depth; d >= 0; d--) ancestors.push($from.node(d).type.name)
  }

  return classifyContext({
    parentTypeName: parent.type.name,
    ancestorTypeNames: ancestors,
    nodeSelectionTypeName: nodeSelName,
    mode: mode || null,
  })
}

/**
 * THE READER FOR `suppressTriggers` — does the caret sit in text where a `@`/`/`
 * picker must not arm? Asked by the editor's caret port before it hands the
 * popover any text to scan, so the picker never sees the inside of a code or
 * diagram block. Resolved through the SAME resolveContext the arrows, Tab, Enter
 * and Home go through, so a kind opts in by naming the flag like any other.
 *
 * The chip-like kinds need nothing: ai-block, web-clip, smart-image, smart-card
 * and attachment are all `caretStop: true`, so no caret enters their text and no
 * trigger can arm there in the first place.
 * @param {any} state @param {any} [view] @returns {boolean}
 */
export function triggersSuppressed(state, view) {
  return !!resolveContext(state, view).policy.suppressTriggers
}

// Block-local text + offsets for raw-text transforms.
function rawTextSpan(state) {
  var $from = state.selection.$from
  var $to = state.selection.$to
  var blockStart = $from.start()
  return {
    text: $from.parent.textContent,
    from: $from.pos - blockStart,
    to: $to.pos - blockStart,
    blockStart: blockStart,
  }
}

// dispatchTextEdit — the PM half of applyTextEdit: same TextEdit, applied as a
// tracked transaction so undo sees one step and the backend's block sync gets a
// normal doc change. Ops are already descending, so positions stay valid.
function dispatchTextEdit(view, blockStart, edit) {
  var tr = view.state.tr
  edit.ops.forEach(function (op) {
    var from = blockStart + op.from
    var to = blockStart + op.to
    if (op.insert) tr.insertText(op.insert, from, to)
    else if (from !== to) tr.delete(from, to)
  })
  var head = edit.head === undefined ? edit.caret : edit.head
  tr.setSelection(TT.TextSelection.create(tr.doc, blockStart + edit.caret, blockStart + head))
  view.dispatch(tr.scrollIntoView())
  return true
}

function applyIndent(view, width) {
  var s = rawTextSpan(view.state)
  var tr = view.state.tr
  indentInsertions(s.text, s.from, s.to, width).forEach(function (ins) {
    tr.insertText(ins.insert, s.blockStart + ins.pos)
  })
  view.dispatch(tr.scrollIntoView())
  return true
}

function applyDedent(view, width) {
  var s = rawTextSpan(view.state)
  var tr = view.state.tr
  var dels = dedentDeletions(s.text, s.from, s.to, width)
  if (!dels.length) return true // consumed: nothing to dedent, but never escape
  dels.forEach(function (d) { tr.delete(s.blockStart + d.from, s.blockStart + d.to) })
  view.dispatch(tr.scrollIntoView())
  return true
}

// TT — the TipTap/PM namespace captured by buildInteractionPolicyExtension
// (the vendor bundle global in the app; a shim of the same classes in
// vitest). Needed because this file is loaded raw in the browser: bare
// '@tiptap/pm/state' imports cannot resolve here.
var TT = null

// insertParagraphAfter — the universal block escape (Shift+Enter anywhere in
// a sieve block; plain Enter on a selected read-only block): a new paragraph
// after the caret's TOP-LEVEL block, caret placed inside it.
function insertParagraphAfter(view) {
  var state = view.state
  var sel = state.selection
  var after
  if (sel.node) {
    after = sel.to
  } else if (sel.$from.depth >= 1) {
    after = sel.$from.after(1)
  } else {
    return false
  }
  var para = state.schema.nodes.paragraph.create()
  var tr = state.tr.insert(after, para)
  tr = tr.setSelection(TT.TextSelection.create(tr.doc, after + 1)).scrollIntoView()
  view.dispatch(tr)
  return true
}

// policyEnterKeydown — the Enter-family entry point, called from editor.js's
// editorProps.handleKeyDown (NOT from the plugin below). Ordering rationale:
// TipTap's core Keymap binds Enter→newlineInCode and Mod-Enter→exitCode, which
// run BEFORE any extension plugin and would consume Enter inside code:true
// blocks (plain newline, no auto-indent; exitCode instead of mode toggle).
// editorProps runs before core, and this function returns false in every
// context the policy does not own, so native prose/list/table Enter (and
// prose Shift+Enter soft breaks) are untouched. Tab is the mirror case:
// native keymaps must win, so it lives in the priority-50 backstop plugin.
// `host` is the surface's parent Editor (WysiwygSurface passes self.#host), threaded
// through to a mode-toggling kind's onModEnter so it can reach the Editor's public API
// (the ContainerTransport verbs) instead of firing a global CustomEvent (P4.F Brief C).
export function policyEnterKeydown(view, event, host) {
  if (event.key !== 'Enter') return false
  return handleEnter(view, event, host)
}

function handleEnter(view, event, host) {
  var ctx = resolveContext(view.state, view)
  var isMod = event.metaKey || event.ctrlKey
  var inSieveBlock = ctx.kind !== 'prose'

  // Shift+Enter: THE universal block escape (contract: "Two chords, one
  // meaning each"). Prose keeps its native soft break (we return false).
  if (event.shiftKey && !isMod) {
    if (!inSieveBlock) return false
    event.preventDefault()
    return insertParagraphAfter(view)
  }

  // Mod+Enter: mode toggle for kinds that declare it; native otherwise.
  if (isMod) {
    if (ctx.policy.modEnterTogglesMode) {
      var beh = getBlockBehaviour(ctx.kind)
      if (beh && beh.onModEnter) {
        event.preventDefault()
        return beh.onModEnter(view, view.state.selection, host) === true
      }
    }
    return false
  }

  // Plain Enter on a selected caret-stop block: escape (this is how prose is
  // planted between two adjacent read-only blocks).
  if (ctx.isNodeSelection && stopActive(ctx.policy, sieveBlockFor(view.state.selection.node))) {
    event.preventDefault()
    return insertParagraphAfter(view)
  }
  if (ctx.policy.readOnlyText) {
    event.preventDefault()
    return true // read-only text: consume
  }
  if (ctx.policy.enterInsertsNewline && !ctx.isNodeSelection && ctx.mode !== 'render') {
    event.preventDefault()
    var s = rawTextSpan(view.state)
    // Between an empty pair, Enter expands to a block before it falls through
    // to the plain newline — this is the `if x {` ⏎ case. Checked first because
    // it SUBSUMES auto-indent (it emits the indented body line itself).
    if (ctx.policy.expandPairOnEnter) {
      var expand = pairExpandEdit(s.text, s.from, s.to, ctx.policy.indentWidth)
      if (expand) return dispatchTextEdit(view, s.blockStart, expand)
    }
    var indent = ctx.policy.autoIndentOnEnter ? leadingIndentAt(s.text, s.from) : ''
    view.dispatch(view.state.tr.insertText('\n' + indent).scrollIntoView())
    return true
  }
  return false // native Enter (prose split etc.)
}

// stopActive — is this kind a caret stop right now? ('render' = only while
// the block is in render mode; true = always.) Reads the TYPED block,
// never a raw attr map (contract §typed block).
/** @param {InteractionPolicy} policy @param {SieveBlock} block */
function stopActive(policy, block) {
  if (policy.caretStop === 'render') return block.mode === MODE.RENDER
  return !!policy.caretStop
}

// atBoundary — is the caret on the block's boundary line in the arrow
// direction? endOfTextblock needs real layout; fall back to hard start/end
// offsets where none exists (unit tests, degenerate views).
function atBoundary(view, down) {
  try {
    return view.endOfTextblock(down ? 'down' : 'up')
  } catch (e) {
    var $h = view.state.selection.$head
    return down ? $h.parentOffset === $h.parent.content.size : $h.parentOffset === 0
  }
}

var IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '')

// isEditingKey — keys that would mutate text content (used for readOnlyText).
function isEditingKey(event) {
  if (event.key === 'Backspace' || event.key === 'Delete') return true
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey
}

// handleSmartHome — contract Home column for raw-text blocks: first press
// jumps to the first non-whitespace character of the line, second to col 0.
function handleSmartHome(view, event) {
  var ctx = resolveContext(view.state, view)
  if (!ctx.policy.smartHome || ctx.isNodeSelection || ctx.mode === 'render') return false
  var s = rawTextSpan(view.state)
  var lineStart = s.text.lastIndexOf('\n', s.from - 1) + 1
  var lineEnd = s.text.indexOf('\n', lineStart)
  if (lineEnd === -1) lineEnd = s.text.length
  var lineText = s.text.slice(lineStart, lineEnd)
  var col = s.from - lineStart
  var targetCol = smartHomeTarget(lineText, col)
  var pos = s.blockStart + lineStart + targetCol
  event.preventDefault()
  view.dispatch(view.state.tr.setSelection(TT.TextSelection.create(view.state.doc, pos)).scrollIntoView())
  return true
}

// handleArrowStop — caret contract clause 4: read-only blocks are a single
// caret stop. Arrow onto one → whole-block NodeSelection; arrow again → past
// it. Prevents the caret diving into non-atom read-only containers.
function handleArrowStop(view, down) {
  var st = view.state
  var sel = st.selection

  // A caret-stop block is selected → move past it.
  if (sel.node) {
    var ctx = resolveContext(st, view)
    if (stopActive(ctx.policy, sieveBlockFor(sel.node))) {
      var target = down ? sel.to : sel.from
      var next = TT.Selection.near(st.doc.resolve(target), down ? 1 : -1)
      view.dispatch(st.tr.setSelection(next).scrollIntoView())
      return true
    }
    return false
  }

  // Caret on a boundary line adjacent to a caret-stop block → select it.
  var $head = sel.$head
  if ($head.depth === 0) return false
  if (!atBoundary(view, down)) return false
  var bound = down ? $head.after(1) : $head.before(1)
  var $bound = st.doc.resolve(bound)
  var adjacent = down ? $bound.nodeAfter : $bound.nodeBefore
  if (!adjacent || adjacent.type.name.indexOf('sieve-') !== 0) return false
  var kind = adjacent.type.name.slice('sieve-'.length)
  if (!stopActive(policyFor(kind), sieveBlockFor(adjacent))) return false
  var pos = down ? bound : bound - adjacent.nodeSize
  view.dispatch(st.tr.setSelection(TT.NodeSelection.create(st.doc, pos)).scrollIntoView())
  return true
}

// handlePolicyTextInput — PM's handleTextInput hook. This, not handleKeyDown,
// is the correct home for the pair behaviours: PM hands us the exact range the
// typed text would replace, and the hook is IME/dead-key safe (on a layout
// where `"` is a dead key, keydown reports the dead key, not the character).
function handlePolicyTextInput(view, from, to, text) {
  var ctx = resolveContext(view.state, view)
  if (ctx.isNodeSelection || ctx.mode === 'render' || ctx.policy.readOnlyText) return false
  if (!ctx.policy.surroundSelection && !ctx.policy.autoClosePairs) return false
  var $from = view.state.selection.$from
  var blockStart = $from.start()
  var edit = textInputEdit(
    $from.parent.textContent, from - blockStart, to - blockStart, text, ctx.policy)
  if (!edit) return false
  return dispatchTextEdit(view, blockStart, edit)
}

// handlePairBackspace — the companion autoclose MUST have: Backspace with the
// caret between an empty pair removes both halves. Without it autoclose strands
// orphaned closers and is worse than no autoclose at all.
function handlePairBackspace(view) {
  var ctx = resolveContext(view.state, view)
  if (!ctx.policy.autoClosePairs || ctx.isNodeSelection || ctx.mode === 'render') return false
  var s = rawTextSpan(view.state)
  var edit = pairDeleteEdit(s.text, s.from, s.to)
  if (!edit) return false
  return dispatchTextEdit(view, s.blockStart, edit)
}

// handleSubstitutionGuard — cancels OS-level automatic text substitution
// (macOS "smart dashes/quotes": `--` + space silently becomes `–`) inside kinds
// that declare blockTextSubstitution. That substitution is a real character
// mutation, not a rendering effect, and in a PlantUML/mermaid fence or a code
// block it corrupts the source — `--`, `---` and `----` all mean different
// things. Confirmed on macOS 2026-07-29; WebKitGTK does not do it.
//
// `insertReplacementText` is the Input Events inputType reserved for
// spell-check/autocorrect/substitution replacements, so this is precise: it
// leaves ordinary typing (`insertText`) and deliberate pastes
// (`insertFromPaste`) — including a genuine em dash — completely alone.
export function handleSubstitutionGuard(event, policy) {
  if (!policy || !policy.blockTextSubstitution) return false
  if (event.inputType !== 'insertReplacementText') return false
  event.preventDefault()
  return true
}

// handleExpand — resolve the caret/selection's block, ask its renderer for
// expand content, and open the lightbox. Returns false (native) when the block
// is not expandable or has nothing to expand right now (diagram edit mode,
// pending image). No per-renderer key handling — the policy owns the chord.
function handleExpand(view) {
  var ctx = resolveContext(view.state, view)
  if (!ctx.policy.expandable) return false
  var beh = getBlockBehaviour(ctx.kind)
  if (!beh || typeof beh.getExpandContent !== 'function') return false
  var sel = view.state.selection
  var pos = sel.node ? sel.from : (sel.$from.depth >= 1 ? sel.$from.before(1) : -1)
  if (pos < 0) return false
  var node = view.state.doc.nodeAt(pos)
  var dom = view.nodeDOM(pos)
  if (!node) return false
  var spec = beh.getExpandContent(node, dom)
  return expandBlock(spec)
}

// handleLinkEdit — the Mod+K chord (contract): the caret inside a `link` mark
// edits that link; a non-empty text selection becomes a new one. PROSE ONLY —
// a link is ordinary markdown, and the raw-text/read-only kinds carry no marks;
// a paragraph INSIDE a sieve container (a web-clip's projected body) is excluded
// too, since that body is Go's to author, not the user's. Returns false (native)
// wherever there is nothing to edit and nothing to create, so the chord stays
// free for anything else that wants it there. ProseLink owns every mark
// mechanic; this is only the routing.
function handleLinkEdit(view) {
  var ctx = resolveContext(view.state, view)
  if (ctx.kind !== 'prose' || ctx.isNodeSelection) return false
  var $from = view.state.selection.$from
  if ($from.depth >= 1 && String($from.node(1).type.name).indexOf('sieve-') === 0) return false
  var link = ProseLink.forSelection(view)
  return link ? link.edit() : false
}

// buildLiteralGlyphsPlugin — the ONE read site translating the literalGlyphs
// flag into something the stylesheet can see. A Decoration, not a classList
// write: PM reverts classes set directly on nodes it owns (native codeBlock),
// and this way sieve NodeViews and native code blocks are handled by the same
// mechanism. Lives here beside the flag rather than in the renderers, which are
// PM-free and must not gain an edge into the editor layer.
function buildLiteralGlyphsPlugin(T) {
  function build(doc) {
    var decos = []
    doc.forEach(function (node, offset) {
      if (policyFor(kindFromTypeName(node.type.name)).literalGlyphs) {
        decos.push(T.Decoration.node(offset, offset + node.nodeSize, { class: 'sieve-literal-glyphs' }))
      }
    })
    return T.DecorationSet.create(doc, decos)
  }
  return new T.Plugin({
    state: {
      init: function (_, instance) { return build(instance.doc) },
      apply: function (tr, set) { return tr.docChanged ? build(tr.doc) : set },
    },
    props: {
      decorations: function (state) { return this.getState(state) },
    },
  })
}

export function buildInteractionPolicyExtension(T) {
  TT = T
  return T.Extension.create({
    name: 'sieveInteractionPolicy',
    // Lower than the default 100: native keymaps (list indent/outdent, table
    // goToNextCell/PreviousCell) run FIRST. We are the backstop, never a shadow.
    priority: 50,
    addProseMirrorPlugins: function () {
      return [
        new T.Plugin({
          props: {
            // Pair behaviours (surround / autoclose / type-over). Runs here
            // rather than in handleKeyDown so IME and dead-key layouts work.
            handleTextInput: function (view, from, to, text) {
              return handlePolicyTextInput(view, from, to, text)
            },
            handleDOMEvents: {
              // OS text substitution (macOS smart dashes) — see
              // handleSubstitutionGuard. A DOM event, not a PM one, so it has
              // to come through handleDOMEvents rather than a PM prop.
              beforeinput: function (view, event) {
                return handleSubstitutionGuard(event, resolveContext(view.state, view).policy)
              },
            },
            handleKeyDown: function (view, event) {
              // Backspace between an empty pair deletes both halves.
              if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                if (handlePairBackspace(view)) { event.preventDefault(); return true }
                // fall through: not between a pair, native Backspace applies
              }
              // Mod+Alt+E — expand the block at the caret/selection into the
              // lightbox (appearance tier; contract). Not a PM/TipTap binding.
              if ((event.key === 'e' || event.key === 'E' || event.code === 'KeyE') &&
                  event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
                if (handleExpand(view)) { event.preventDefault(); return true }
                return false
              }
              // Mod+K — edit the link at the caret, or make one out of the
              // selected text (contract; the ONE link CHORD, and the only way to
              // link text already in the document — the Insert-from-URL dialog's
              // Link rung covers a URL that is not in it yet).
              // Editor-owned and unclaimed by the native menu.
              if ((event.key === 'k' || event.key === 'K' || event.code === 'KeyK') &&
                  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
                if (handleLinkEdit(view)) { event.preventDefault(); return true }
                return false
              }
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                return handleArrowStop(view, event.key === 'ArrowDown')
              }
              // Smart home: the Home key (Linux/Windows; fn+Left on Mac), and
              // Cmd+Left on macOS — the idiomatic line-start gesture there
              // (VS Code treats it as smart-home too). Only in raw-text
              // blocks; native everywhere else. Shift variants (selection)
              // stay native.
              if (event.key === 'Home' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                return handleSmartHome(view, event)
              }
              if (IS_MAC && event.key === 'ArrowLeft' && event.metaKey &&
                  !event.shiftKey && !event.ctrlKey && !event.altKey) {
                return handleSmartHome(view, event)
              }
              // Read-only text (log): consume typing/deleting keys so the
              // content cannot be edited; caret movement and copy still work.
              if (isEditingKey(event)) {
                var roCtx = resolveContext(view.state, view)
                if (roCtx.policy.readOnlyText && !roCtx.isNodeSelection) {
                  event.preventDefault()
                  return true
                }
              }
              // keyCode 9 matters: WebKitGTK can report Shift+Tab as the X11
              // keysym ISO_Left_Tab in event.key (Chrome always says 'Tab'),
              // which made Shift+Tab fall through to focus navigation in the
              // wails app while working in Chrome.
              var isTabKey = event.key === 'Tab' || event.key === 'ISO_Left_Tab' || event.keyCode === 9
              if (!isTabKey) return false
              if (event.metaKey || event.ctrlKey || event.altKey) return false
              var isShiftTab = event.shiftKey || event.key === 'ISO_Left_Tab'
              var ctx = resolveContext(view.state, view)
              // Native structural keymaps already ran (priority order); from
              // here we own the key so focus can never escape the editor.
              if (ctx.inList || ctx.inTable) {
                // e.g. Shift+Tab in the first table cell: consume ∅.
                event.preventDefault()
                return true
              }
              if (ctx.policy.tabIndents && !ctx.isNodeSelection && ctx.mode !== 'render') {
                event.preventDefault()
                return isShiftTab
                  ? applyDedent(view, ctx.policy.indentWidth)
                  : applyIndent(view, ctx.policy.indentWidth)
              }
              // Plain paragraph / read-only / caret-stop: consume ∅.
              event.preventDefault()
              return true
            },
          },
        }),
        buildLiteralGlyphsPlugin(T),
      ]
    },
  })
}
