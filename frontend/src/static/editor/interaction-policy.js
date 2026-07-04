// interaction-policy.js — ONE shared mechanism for keyboard interaction.
// Renderers DECLARE an interactionPolicy; this module resolves the caret's
// context and applies the policy. Per-renderer key handlers are forbidden
// (docs/editor-interaction-contract.md is the normative behaviour spec).
//
// Layered: pure helpers (top section, vitest-tested) + the TipTap extension
// (browser-only, added by editor.js at priority 50 so native keymaps —
// list indent, table cell nav — always run first: defer first, consume last).

import { getBlockBehaviour } from '../block/block-kinds.js'

export var DEFAULT_POLICY = {
  rawText: false,             // literal paste target; Tab indents inside
  indentWidth: 0,             // spaces per Tab where rawText
  enterInsertsNewline: false,
  autoIndentOnEnter: false,
  modEnterTogglesMode: false, // diagram: Mod+Enter flips edit/render instead of escape
  readOnlyText: false,        // log: caret may enter text, typing is consumed
  caretStop: false,           // read-only block: arrows select it as one stop ('render' = only in render mode)
}

export function policyFor(kind) {
  var beh = getBlockBehaviour(kind)
  var declared = (beh && beh.interactionPolicy) || {}
  var merged = {}
  for (var k in DEFAULT_POLICY) merged[k] = (k in declared) ? declared[k] : DEFAULT_POLICY[k]
  return merged
}

var LIST_TYPES = { listItem: 1, taskItem: 1 }
var TABLE_TYPES = { table: 1, tableRow: 1, tableCell: 1, tableHeader: 1 }

function kindFromTypeName(name) {
  if (!name) return 'prose'
  return name.indexOf('sieve-') === 0 ? name.slice('sieve-'.length) : 'prose'
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

// ── browser layer: PM state → classified context, and the TipTap extension ──

export function resolveContext(state) {
  var sel = state.selection
  var nodeSelName = sel.node ? sel.node.type.name : null
  var $from = sel.$from
  var ancestors = []
  for (var d = $from.depth; d >= 0; d--) ancestors.push($from.node(d).type.name)
  var parent = $from.parent
  return classifyContext({
    parentTypeName: parent.type.name,
    ancestorTypeNames: ancestors,
    nodeSelectionTypeName: nodeSelName,
    mode: (sel.node ? sel.node.attrs && sel.node.attrs.mode : parent.attrs && parent.attrs.mode) || null,
  })
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
// (window.TipTap in the app; a shim of the same classes in vitest). Needed
// because this file is loaded raw in the browser: bare '@tiptap/pm/state'
// imports cannot resolve here.
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
export function policyEnterKeydown(view, event) {
  if (event.key !== 'Enter') return false
  return handleEnter(view, event)
}

function handleEnter(view, event) {
  var ctx = resolveContext(view.state)
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
        return beh.onModEnter(view, view.state.selection) === true
      }
    }
    return false
  }

  // Plain Enter on a selected caret-stop block: escape (this is how prose is
  // planted between two adjacent read-only blocks).
  if (ctx.isNodeSelection && stopActive(ctx.policy, view.state.selection.node.attrs)) {
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
    var indent = ctx.policy.autoIndentOnEnter ? leadingIndentAt(s.text, s.from) : ''
    view.dispatch(view.state.tr.insertText('\n' + indent).scrollIntoView())
    return true
  }
  return false // native Enter (prose split etc.)
}

// stopActive — is this kind a caret stop right now? ('render' = only while
// the block is in render mode; true = always.)
function stopActive(policy, attrs) {
  if (policy.caretStop === 'render') return !!(attrs && attrs.mode === 'render')
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
  var ctx = resolveContext(view.state)
  if (!ctx.policy.rawText || ctx.isNodeSelection || ctx.mode === 'render') return false
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
    var ctx = resolveContext(st)
    if (stopActive(ctx.policy, sel.node.attrs)) {
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
  if (!stopActive(policyFor(kind), adjacent.attrs)) return false
  var pos = down ? bound : bound - adjacent.nodeSize
  view.dispatch(st.tr.setSelection(TT.NodeSelection.create(st.doc, pos)).scrollIntoView())
  return true
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
            handleKeyDown: function (view, event) {
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
                var roCtx = resolveContext(view.state)
                if (roCtx.policy.readOnlyText && !roCtx.isNodeSelection) {
                  event.preventDefault()
                  return true
                }
              }
              if (event.key !== 'Tab') return false
              if (event.metaKey || event.ctrlKey || event.altKey) return false
              var ctx = resolveContext(view.state)
              // Native structural keymaps already ran (priority order); from
              // here we own the key so focus can never escape the editor.
              if (ctx.inList || ctx.inTable) {
                // e.g. Shift+Tab in the first table cell: consume ∅.
                event.preventDefault()
                return true
              }
              if (ctx.policy.rawText && !ctx.isNodeSelection && ctx.mode !== 'render') {
                event.preventDefault()
                return event.shiftKey
                  ? applyDedent(view, ctx.policy.indentWidth)
                  : applyIndent(view, ctx.policy.indentWidth)
              }
              // Plain paragraph / read-only / caret-stop: consume ∅.
              event.preventDefault()
              return true
            },
          },
        }),
      ]
    },
  })
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.buildInteractionPolicyExtension = buildInteractionPolicyExtension
  window.TipTap.resolveInteractionContext = resolveContext
  window.TipTap.policyEnterKeydown = policyEnterKeydown
}
