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
