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

// policyEnterKeydown — the Enter-family entry point, called from editor.js's
// editorProps.handleKeyDown (NOT from the plugin below). Ordering rationale:
// TipTap's core Keymap binds Enter→newlineInCode and Mod-Enter→exitCode, which
// run BEFORE any extension plugin and would consume Enter inside code:true
// blocks (plain newline, no auto-indent; exitCode instead of mode toggle).
// editorProps runs before core, and this function returns false in every
// context the policy does not own, so native prose/list/table Enter is
// untouched. Tab is the mirror case: native keymaps must win, so it lives in
// the priority-50 backstop plugin below.
export function policyEnterKeydown(view, event) {
  if (event.key !== 'Enter') return false
  return handleEnter(view, event)
}

function handleEnter(view, event) {
  var ctx = resolveContext(view.state)
  var isMod = event.metaKey || event.ctrlKey
  if (isMod && ctx.policy.modEnterTogglesMode) {
    // Declared per-kind override (diagram): Mod+Enter flips edit/render.
    var beh = getBlockBehaviour(ctx.kind)
    if (beh && beh.onModEnter) {
      event.preventDefault()
      return beh.onModEnter(view, view.state.selection) === true
    }
  }
  if (ctx.policy.readOnlyText && !isMod) {
    event.preventDefault()
    return true // read-only text: consume
  }
  if (ctx.policy.enterInsertsNewline && !ctx.isNodeSelection && ctx.mode !== 'render' && !isMod) {
    event.preventDefault()
    var s = rawTextSpan(view.state)
    var indent = ctx.policy.autoIndentOnEnter ? leadingIndentAt(s.text, s.from) : ''
    view.dispatch(view.state.tr.insertText('\n' + indent).scrollIntoView())
    return true
  }
  return false // native Enter (prose split etc.); Mod+Enter escape is added by the caret-contract layer
}

export function buildInteractionPolicyExtension(T) {
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
