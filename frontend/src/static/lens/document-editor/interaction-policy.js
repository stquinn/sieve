// ONE shared mechanism for keyboard interaction. Renderers DECLARE an
// interactionPolicy; this module resolves the caret's context and applies the
// policy. Per-renderer key handlers are forbidden, and
// docs/editor-interaction-contract.md is the normative behaviour spec.
//
// Layered: pure helpers (top section, vitest-tested) plus the TipTap extension,
// added at priority 50 so native keymaps — list indent, table cell nav — always
// run first. Defer first, consume last.
//
// NOT OWNED HERE: Mod+Click on a link (open externally). It is deliberately
// APP-GLOBAL rather than editor-scoped, because links appear outside the editor
// too and in a Wails webview an anchor that navigates replaces the running
// application, so the suppression must be unconditional. Its owner is
// shell/workspace.js's document-level CAPTURE-phase click listener, which calls
// stopPropagation — so a Mod+Click handler added here would be dead code.

import { getBlockBehaviour } from '../../renderers/block-kinds.js'
import { expandBlock } from '../../ui/media-lightbox.js'
import { MODE } from '../../contract/sieve-block.js'
import { sieveBlockFor } from './surfaces/sieve-block-extension.js'
import { ProseLink } from './surfaces/prose-link.js'

/** @typedef {import('../../contract/sieve-block.js').SieveBlock} SieveBlock */

/**
 * The full set of behaviours a kind may opt into. Kinds declare a Partial of this
 * as `interactionPolicy`; policyFor merges it over DEFAULT_POLICY.
 *
 * EVERY field is a DISCRETE BEHAVIOUR opted into by name. There is deliberately
 * NO genre field ('code' vs 'prose'): a category is a second declaration
 * mechanism, and it lies the moment one kind wants code-style autoclose with
 * prose-style Enter. A flag is born WITH its reader — never declare one before
 * something consumes it.
 *
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

// The "yep, this is code" preset: every literal-source-text behaviour under one
// name, SPREAD AT DECLARATION TIME by the kinds that want it. policyFor only ever
// sees plain booleans, so there stays exactly ONE declaration mechanism, and a
// kind opts out of any line by overriding that key after the spread.
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
  // `@Override`, `@media` and `@Component` sit at a line start after whitespace,
  // so they satisfy the `@` trigger's boundary rule and would open the picker
  // only to flash shut when the library search comes back dry.
  suppressTriggers: true,
})

// The ONE table every pair behaviour reads (surround, autoclose, type-over,
// backspace-deletes-pair, Enter expansion). Frozen and shared so the PM surface
// and the markdown textarea can never drift on what a "pair" is. Markdown
// emphasis (* _) is deliberately absent: Mod+B/Mod+I already own bold/italic,
// and surrounding a literal asterisk would fight the user more often than help.
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
// user is about to wrap by hand. Typing `(` before `foo` gives a lone `(`; before
// a space, a newline, EOF or a closing bracket it pairs.
function isWordChar(ch) {
  return !!ch && /[\w$]/.test(ch)
}

// Defaults first, then the kind's declared overrides for KNOWN keys only: a flag
// name that is not in DEFAULT_POLICY is silently ignored, so the JSDoc typedef on
// `interactionPolicy` is the only thing standing between a typo'd flag and a
// behaviour that quietly never happens.
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
  // Native TipTap code blocks share the 'code' interaction policy: the
  // contract's Code row applies to BOTH code surfaces.
  if (name === 'codeBlock') return 'code'
  return 'prose'
}

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
  // Collapsed caret: insert at the caret, pushing text right. Selection: indent
  // every touched line at its start.
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

// Every pair behaviour returns the same edit shape, and both surfaces apply it
// the same way — the PM plugin as a transaction, the markdown <textarea> via
// applyTextEdit. That shared shape is why the rule cannot drift between them.
//
// OFFSET CAVEAT: block-local offsets derive from `parent.textContent`, which
// drifts from PM positions in a textblock containing inline ATOMS. Only the
// character-peeking guards index into `text`, and those run exclusively under
// `autoClosePairs` — declared only by literal-source-text kinds, whose `text*`
// content cannot hold an atom. `surroundEdit`, the one behaviour prose enables,
// never indexes `text` at all.
//
/**
 * An edit is a list of point operations in DESCENDING position order, so applying
 * them in sequence never invalidates a later one's offsets.
 *
 * Surround is deliberately two INSERTIONS rather than one replacement: in prose
 * the wrapped range carries marks, and re-writing it as plain text would silently
 * flatten them. Nothing here ever rewrites existing content.
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
 * Typing a pair character over a NON-EMPTY selection wraps it. The selection is
 * preserved, now inside the pair, so the gesture can be repeated to nest.
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

/** Typing an opener at a collapsed caret inserts the whole pair.
 *  @returns {TextEdit|null} */
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
 * Backspace with the caret between an empty pair removes both halves. Without
 * this, autoclose strands orphaned closers and is worse than no autoclose.
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
 * surfaces call. Order matters: surround (there is a selection) → type-over (the
 * closer is already there) → autoclose. Returns null for "not ours".
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

/** Apply an edit to a plain string — used by the markdown <textarea> surface and
 *  by the unit tests, so the behaviour under test is the shipped one.
 *  @param {string} text @param {import('./interaction-policy.js').TextEdit} edit
 *  @returns {{text: string, caret: number, head: number}} */
export function applyTextEdit(text, edit) {
  var out = text
  edit.ops.forEach(function (op) {
    out = out.slice(0, op.from) + op.insert + out.slice(op.to)
  })
  return { text: out, caret: edit.caret, head: edit.head === undefined ? edit.caret : edit.head }
}

export function resolveContext(state, view) {
  var sel = state.selection
  var nodeSelName = sel.node ? sel.node.type.name : null
  var $from = sel.$from
  var ancestors = []
  var parent = $from.parent
  // The policy never indexes raw attr maps. Via sieveBlockFor with NO
  // blockService, because the mode here is the LIVE presentation mode toggled
  // locally by Mod+Enter — never Go truth, which would lag the toggle.
  var blockMode = sieveBlockFor(sel.node || parent).mode
  var mode = blockMode === MODE.DEFAULT ? null : blockMode

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
 * THE READER FOR `suppressTriggers`: does the caret sit in text where a `@`/`/`
 * picker must not arm? Asked by the caret port before it hands the popover any
 * text to scan, and resolved through the SAME resolveContext the arrows, Tab,
 * Enter and Home go through, so a kind opts in by naming the flag.
 *
 * The chip-like kinds need nothing: they are all `caretStop: true`, so no caret
 * enters their text.
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

// The PM half of applyTextEdit: the same TextEdit, applied as a tracked
// transaction so undo sees one step and the backend's block sync gets a normal
// doc change. Ops are already descending, so positions stay valid.
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

// The TipTap/PM namespace captured by buildInteractionPolicyExtension. Needed
// because this file is loaded raw in the browser, where bare '@tiptap/pm/state'
// imports cannot resolve.
var TT = null

// The universal block escape (Shift+Enter anywhere in a sieve block; plain Enter
// on a selected read-only block): a new paragraph after the caret's TOP-LEVEL
// block, caret placed inside it.
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

// The Enter-family entry point, called from editorProps.handleKeyDown rather than
// the plugin below: TipTap's core Keymap binds Enter→newlineInCode and
// Mod-Enter→exitCode, which run BEFORE any extension plugin and would consume
// Enter inside code:true blocks. editorProps runs before core, and this returns
// false in every context the policy does not own. Tab is the mirror case — native
// keymaps must win there, so it lives in the priority-50 backstop plugin.
//
// `host` is the surface's parent Editor, threaded through to a mode-toggling
// kind's onModEnter so it can reach the Editor's public API.
export function policyEnterKeydown(view, event, host) {
  if (event.key !== 'Enter') return false
  return handleEnter(view, event, host)
}

function handleEnter(view, event, host) {
  var ctx = resolveContext(view.state, view)
  var isMod = event.metaKey || event.ctrlKey
  var inSieveBlock = ctx.kind !== 'prose'

  // Shift+Enter: THE universal block escape. Prose keeps its native soft break.
  if (event.shiftKey && !isMod) {
    if (!inSieveBlock) return false
    event.preventDefault()
    return insertParagraphAfter(view)
  }

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

  // Plain Enter on a selected caret-stop block: escape. This is how prose is
  // planted between two adjacent read-only blocks.
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
    // Between an empty pair, Enter expands to a block before it falls through to
    // the plain newline. Checked first because it SUBSUMES auto-indent — it emits
    // the indented body line itself.
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

// Is this kind a caret stop right now? 'render' means only while the block is in
// render mode; true means always. Reads the TYPED block, never a raw attr map.
/** @param {InteractionPolicy} policy @param {SieveBlock} block */
function stopActive(policy, block) {
  if (policy.caretStop === 'render') return block.mode === MODE.RENDER
  return !!policy.caretStop
}

// Is the caret on the block's boundary line in the arrow direction?
// endOfTextblock needs real layout, so fall back to hard start/end offsets where
// none exists.
function atBoundary(view, down) {
  try {
    return view.endOfTextblock(down ? 'down' : 'up')
  } catch (e) {
    var $h = view.state.selection.$head
    return down ? $h.parentOffset === $h.parent.content.size : $h.parentOffset === 0
  }
}

var IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '')

// Keys that would mutate text content, for readOnlyText.
function isEditingKey(event) {
  if (event.key === 'Backspace' || event.key === 'Delete') return true
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey
}

// The contract's Home column for raw-text blocks: first press jumps to the first
// non-whitespace character of the line, second to col 0.
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

// Caret contract clause 4: read-only blocks are a single caret stop. Arrow onto
// one selects the whole block; arrow again moves past it. This prevents the caret
// diving into non-atom read-only containers.
function handleArrowStop(view, down) {
  var st = view.state
  var sel = st.selection

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

// PM's handleTextInput hook. This, not handleKeyDown, is the correct home for the
// pair behaviours: PM hands us the exact range the typed text would replace, and
// the hook is IME/dead-key safe — on a layout where `"` is a dead key, keydown
// reports the dead key rather than the character.
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

// The companion autoclose MUST have: Backspace with the caret between an empty
// pair removes both halves, so autoclose never strands orphaned closers.
function handlePairBackspace(view) {
  var ctx = resolveContext(view.state, view)
  if (!ctx.policy.autoClosePairs || ctx.isNodeSelection || ctx.mode === 'render') return false
  var s = rawTextSpan(view.state)
  var edit = pairDeleteEdit(s.text, s.from, s.to)
  if (!edit) return false
  return dispatchTextEdit(view, s.blockStart, edit)
}

// Cancels OS-level automatic text substitution (macOS smart dashes: `--` plus a
// space silently becomes an en dash) inside kinds declaring blockTextSubstitution.
// That substitution is a real character mutation, not a rendering effect, and in a
// mermaid fence or a code block it corrupts the source — `--`, `---` and `----`
// all mean different things.
//
// `insertReplacementText` is the inputType reserved for autocorrect/substitution
// replacements, so ordinary typing and deliberate pastes are left alone.
export function handleSubstitutionGuard(event, policy) {
  if (!policy || !policy.blockTextSubstitution) return false
  if (event.inputType !== 'insertReplacementText') return false
  event.preventDefault()
  return true
}

// Resolve the caret/selection's block, ask its renderer for expand content, and
// open the lightbox. Returns false (native) when the block is not expandable or
// has nothing to expand right now.
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

// The Mod+K chord: the caret inside a `link` mark edits that link; a non-empty
// text selection becomes a new one. PROSE ONLY — a link is ordinary markdown, and
// the raw-text/read-only kinds carry no marks. A paragraph INSIDE a sieve
// container is excluded too, since that body is Go's to author. ProseLink owns
// every mark mechanic; this is only routing.
function handleLinkEdit(view) {
  var ctx = resolveContext(view.state, view)
  if (ctx.kind !== 'prose' || ctx.isNodeSelection) return false
  var $from = view.state.selection.$from
  if ($from.depth >= 1 && String($from.node(1).type.name).indexOf('sieve-') === 0) return false
  var link = ProseLink.forSelection(view)
  return link ? link.edit() : false
}

// The ONE read site translating the literalGlyphs flag into something the
// stylesheet can see. A Decoration, not a classList write: PM reverts classes set
// directly on nodes it owns, and this way sieve NodeViews and native code blocks
// go through the same mechanism.
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
    // Lower than the default 100: native keymaps run FIRST. We are the backstop,
    // never a shadow.
    priority: 50,
    addProseMirrorPlugins: function () {
      return [
        new T.Plugin({
          props: {
            // Pair behaviours (surround / autoclose / type-over). Here rather
            // than in handleKeyDown so IME and dead-key layouts work.
            handleTextInput: function (view, from, to, text) {
              return handlePolicyTextInput(view, from, to, text)
            },
            handleDOMEvents: {
              // A DOM event, not a PM one, so it comes through handleDOMEvents
              // rather than a PM prop.
              beforeinput: function (view, event) {
                return handleSubstitutionGuard(event, resolveContext(view.state, view).policy)
              },
            },
            handleKeyDown: function (view, event) {
              if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                if (handlePairBackspace(view)) { event.preventDefault(); return true }
              }
              // Mod+Alt+E — expand the block at the caret into the lightbox.
              if ((event.key === 'e' || event.key === 'E' || event.code === 'KeyE') &&
                  event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
                if (handleExpand(view)) { event.preventDefault(); return true }
                return false
              }
              // Mod+K — the ONE link CHORD, and the only way to link text
              // already in the document; the Insert-from-URL dialog's Link rung
              // covers a URL that is not in it yet.
              if ((event.key === 'k' || event.key === 'K' || event.code === 'KeyK') &&
                  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
                if (handleLinkEdit(view)) { event.preventDefault(); return true }
                return false
              }
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                  !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                return handleArrowStop(view, event.key === 'ArrowDown')
              }
              // Smart home: the Home key, and Cmd+Left on macOS. Only in
              // raw-text blocks; Shift variants stay native.
              if (event.key === 'Home' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                return handleSmartHome(view, event)
              }
              if (IS_MAC && event.key === 'ArrowLeft' && event.metaKey &&
                  !event.shiftKey && !event.ctrlKey && !event.altKey) {
                return handleSmartHome(view, event)
              }
              // Read-only text: consume typing and deleting keys so the content
              // cannot be edited; caret movement and copy still work.
              if (isEditingKey(event)) {
                var roCtx = resolveContext(view.state, view)
                if (roCtx.policy.readOnlyText && !roCtx.isNodeSelection) {
                  event.preventDefault()
                  return true
                }
              }
              // keyCode 9 matters: WebKitGTK can report Shift+Tab as the X11
              // keysym ISO_Left_Tab in event.key, which made Shift+Tab fall
              // through to focus navigation in the wails app.
              var isTabKey = event.key === 'Tab' || event.key === 'ISO_Left_Tab' || event.keyCode === 9
              if (!isTabKey) return false
              if (event.metaKey || event.ctrlKey || event.altKey) return false
              var isShiftTab = event.shiftKey || event.key === 'ISO_Left_Tab'
              var ctx = resolveContext(view.state, view)
              // Native structural keymaps already ran; from here we own the key
              // so focus can never escape the editor.
              if (ctx.inList || ctx.inTable) {
                event.preventDefault()
                return true
              }
              if (ctx.policy.tabIndents && !ctx.isNodeSelection && ctx.mode !== 'render') {
                event.preventDefault()
                return isShiftTab
                  ? applyDedent(view, ctx.policy.indentWidth)
                  : applyIndent(view, ctx.policy.indentWidth)
              }
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
