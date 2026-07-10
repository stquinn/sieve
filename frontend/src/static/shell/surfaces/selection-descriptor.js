// @ts-check
// selection-descriptor.js — the PM→plain SelectionContext-descriptor core (P3.C).
//
// The single Node-loadable unit that turns a live ProseMirror (doc + selection +
// effective range) into the PLAIN raw descriptor the SelectionModel ingests —
// INCLUDING the resolved AI `target` ({kind, ref, range, label}) and its friendly
// label. NO PM node ever escapes: the resolver USES PM to PRODUCE plain values;
// the descriptor STORES plain values only.
//
// This is where `resolveAiTarget` LIVES now (P3.C store-only): the standalone
// symbol is retired — the outcome is generated here, by the editor, and stored in
// the context. Consumers READ `context.target`; they never re-derive.
//
// Loads in Node/vitest with a minimal window.TipTap stub (like the old
// ai-target.js): its only external is `T.getSieveBlockLabel(node)` for rich sieve
// block labels — passed in, read lazily. No TipTap-construction deps.
//
// WysiwygSurface.feedSelection computes the effective range `er` (block-chrome
// range + read-only-region DOM fold — the parts that need the live view/DOM) then
// delegates here for the PM-only descriptor assembly. The 23-test adapter reuses
// THIS SAME function so the tests exercise the real path (no drift).

/**
 * @typedef {Object} EffectiveRange
 * @property {number} from
 * @property {number} to
 * @property {boolean} active
 * @property {boolean} [isBlockRange]
 * @property {boolean} [isNodeSelection]
 */

// ── label helpers (moved from ai-target.js; owned here now) ─────────────────────

/** Title-case a kind for a fallback label ("smart-image" → "Smart image"). */
export function titleCase(kind) {
  if (!kind) return 'Block'
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')
}

/** Quote + truncate a snippet on a word boundary near 20 chars. */
export function quoteSnippet(text) {
  const s = (text || '').replace(/\s+/g, ' ').trim()
  if (!s) return 'Selection'
  if (s.length > 20) {
    let cut = s.slice(0, 20)
    const sp = cut.lastIndexOf(' ')
    if (sp > 8) cut = cut.slice(0, sp)
    return '"' + cut + '…"'
  }
  return '"' + s + '"'
}

// Human labels for native unit node types, so the Ask panel header ("Ask About
// <label>") reads naturally (not "Ask About BulletList").
const NATIVE_UNIT_LABEL = Object.freeze({
  blockquote: 'Quote', codeBlock: 'Code Block',
  bulletList: 'List', orderedList: 'List', taskList: 'Task List',
  table: 'Table', image: 'Image', horizontalRule: 'Divider',
})

// isFlowingText: the ONE discriminator (D-r.7), by KIND STRING now. A top-level
// block is flowing text iff it is a paragraph, heading, or proseGroup — content a
// bare caret can't disambiguate, so it targets the whole document. EVERY other
// top-level kind (blockquote, code, list, table, image, hr, all structured sieve-*)
// is a discrete UNIT you target as a whole by its id.
//
// proseGroup counts as flowing text because it is a backend contrivance: one
// multi-paragraph prose block rendered under a shared id, visually
// indistinguishable from individually-minted paragraphs. A bare caret may only
// target units the user can SEE as units.
/** @param {string|null} kind */
export function isFlowingText(kind) {
  return kind === 'paragraph' || kind === 'heading' || kind === 'proseGroup'
}

/** @param {any} node @returns {string|null} the block's durable id, or null */
export function nodeBlockId(node) {
  const id = node && node.attrs && node.attrs.id
  return id || null
}

/**
 * The block kind as a PLAIN string: a sieve-* node carries `attrs.kind`; a native
 * prose node is its PM type name. Null when no node owns the selection.
 * @param {any} node @returns {string|null}
 */
export function nodeBlockKind(node) {
  if (!node || !node.type) return null
  if (node.attrs && node.attrs.kind) return node.attrs.kind
  return node.type.name || null
}

/** @param {any} node @returns {string|null} block ref/anchor (ai-block re-chain) */
export function nodeRef(node) {
  const ref = node && node.attrs && node.attrs.ref
  return ref || null
}

/**
 * The friendly display label for the resolved target — ALWAYS populated. The
 * surface holds the PM `primary` node here, so RICH sieve labels
 * (getSieveBlockLabel → renderer.buildAiCtx(node).contextLabel, e.g. 'Javascript
 * Code Block') are preserved; it must not regress to a bare title-cased kind. This
 * is the ported `describeTarget`, driven by selectionType+blockKind instead of a
 * naked node.
 * @param {any} primary                    the PM node owning the selection (or null)
 * @param {'none'|'caret'|'range'|'block'} selectionType
 * @param {string|null} blockKind
 * @param {string|null} selectedText
 * @param {any} T                          the vendor bundle (for T.getSieveBlockLabel)
 * @returns {string}
 */
export function labelFor(primary, selectionType, blockKind, selectedText, T) {
  // A range, OR a node-selected proseGroup (invisible grouping → its passage), is
  // a text selection → a snippet.
  if (selectionType === 'range' ||
      (selectionType === 'block' && blockKind === 'proseGroup')) {
    return quoteSnippet(
      selectedText != null ? selectedText : (primary ? primary.textContent : ''))
  }
  // A whole-unit NodeSelection / caret-in-unit → the block's noun.
  if (primary && selectionType !== 'none') {
    const name = primary.type.name
    if (name === 'aiBlock' || name === 'sieve-ai-block') return 'Follow-up'
    if (name.indexOf('sieve-') === 0) {
      return (T && T.getSieveBlockLabel)
        ? T.getSieveBlockLabel(primary)
        : titleCase(primary.attrs && primary.attrs.kind)
    }
    if (!isFlowingText(name) && NATIVE_UNIT_LABEL[name]) return NATIVE_UNIT_LABEL[name]
  }
  return 'Document'
}

/**
 * Every top-level block whose extent overlaps `[from,to]`, in document order, as
 * `{node, id}` (overlap: `from < node.to && to > node.from`). A collapsed caret
 * still lands in exactly the block it sits in.
 * @param {any} doc @param {number} from @param {number} to
 * @returns {Array<{node:any,id:string|null}>}
 */
export function blocksInRange(doc, from, to) {
  const out = []
  doc.forEach((node, offset) => {
    const nodeFrom = offset
    const nodeTo = offset + node.nodeSize
    const overlaps = (from === to)
      ? (from >= nodeFrom && from <= nodeTo)
      : (from < nodeTo && to > nodeFrom)
    if (overlaps) out.push({ node, id: nodeBlockId(node) })
  })
  return out
}

/**
 * The PRIMARY block node: a NodeSelection targets its own node; otherwise the
 * block at the selection HEAD (via $from) WHEN that block is inside the spanned
 * range. When the effective range was re-targeted (a read-only-region DOM fold / a
 * block-chrome range that doesn't cover the PM head), the head block is NOT in the
 * span, so fall to the FIRST block the range spans.
 *
 * DOC-LEVEL GAP (depth 0 — a collapsed caret at a point between top-level nodes,
 * e.g. after an atom / at doc end): faithful port of the old topLevelForCaret gap
 * branch — prefer the ADJACENT non-flowing UNIT (nodeBefore, then nodeAfter) so a
 * caret sitting in the gap after an hr / before a paragraph still targets that unit,
 * never a flowing paragraph. Falls back to the index-clamped child otherwise (range
 * spans that don't cover the head).
 * @param {any} doc @param {any} sel @param {any} span
 * @returns {any|null}
 */
export function primaryBlock(doc, sel, span) {
  if (sel.node) return sel.node
  const spanNodes = span.map((b) => b.node)
  let head = null
  const $from = sel.$from
  if ($from && $from.depth >= 1) head = $from.node(1)
  else if ($from && doc.childCount) {
    // Doc-level gap: prefer the adjacent non-flowing unit (gap-adjacency).
    const before = $from.nodeBefore
    if (before && !isFlowingText(before.type.name)) return before
    const after = $from.nodeAfter
    if (after && !isFlowingText(after.type.name)) return after
    // No adjacent unit (both flowing / absent) → the index-clamped child.
    const idx = Math.max(0, doc.resolve($from.pos).index(0))
    head = doc.child(Math.min(idx, doc.childCount - 1))
  }
  if (head && spanNodes.indexOf(head) >= 0) return head
  return span.length ? span[0].node : head
}

/**
 * The resolved AI `target` — the four ordered cases (D-r.7), from PLAIN values.
 * The label is baked in (labelFor ran while `primary` was in hand).
 *   (a) NodeSelection of a UNIT (proseGroup excluded) → block by id
 *   (b) text selection OR node-selected proseGroup → selection + ref chain
 *   (c) bare caret in a UNIT → block by id
 *   (d) bare caret in flowing text / none → document
 * @param {'none'|'caret'|'range'|'block'} selectionType
 * @param {string|null} blockKind
 * @param {string|null} blockId
 * @param {string[]} blockIds
 * @param {{from:number,to:number}|null} range
 * @param {string} label
 * @returns {{kind:'block'|'selection'|'document', ref:string, range:{from:number,to:number}|null, label:string}}
 */
export function resolveTarget(selectionType, blockKind, blockId, blockIds, range, label) {
  // (a) NodeSelection of a UNIT block.
  if (selectionType === 'block' && blockKind !== 'proseGroup') {
    return { kind: 'block', ref: blockId || 'doc', range: range, label: label }
  }
  // (b) non-empty text selection OR node-selected proseGroup → ref chain.
  if (selectionType === 'range' || (selectionType === 'block' && blockKind === 'proseGroup')) {
    const ref = (blockIds && blockIds.length) ? blockIds.join(',') : (blockId || 'doc')
    return { kind: 'selection', ref: ref, range: range, label: label }
  }
  // (c) bare caret in a UNIT.
  if (selectionType === 'caret' && !isFlowingText(blockKind)) {
    return { kind: 'block', ref: blockId || 'doc', range: range, label: label }
  }
  // (d) bare caret in flowing text / none → the document.
  return { kind: 'document', ref: 'doc', range: null, label: label }
}

/**
 * Build the full PLAIN raw descriptor from a live PM (doc + selection + effective
 * range). The ONE place PM is read into a descriptor — reused by
 * WysiwygSurface.feedSelection and the test adapter, so they can't drift.
 *
 * Classification (locked ruling folds dom/block-range → 'range'): single
 * NodeSelection → 'block'; block-range OR dom-fold → 'range'; collapsed → 'caret';
 * else non-empty text → 'range'.
 *
 * @param {any} doc              the PM doc
 * @param {any} sel              the PM selection (state.selection)
 * @param {EffectiveRange} er    the effective range (surface-computed; = the live
 *                               selection for a plain caret / single NodeSelection)
 * @param {any} T                the vendor bundle (for T.getSieveBlockLabel)
 * @param {string|null} [domSelText]  read-only-region DOM highlight text (F5 fold), or null
 * @returns {import('../selection-model.js').RawSelectionDescriptor}
 */
export function buildSelectionDescriptor(doc, sel, er, T, domSelText = null) {
  let selectionType
  if (er.isNodeSelection && !er.isBlockRange) selectionType = 'block'
  else if (er.isBlockRange) selectionType = 'range'
  else if (domSelText !== null) selectionType = 'range'
  else if (er.from === er.to) selectionType = 'caret'
  else selectionType = 'range'

  const span = blocksInRange(doc, er.from, er.to)
  const primary = primaryBlock(doc, sel, span)

  let selectedText = null
  if (selectionType === 'range') {
    selectedText = domSelText !== null ? domSelText : doc.textBetween(er.from, er.to, ' ')
  }

  const primaryId = nodeBlockId(primary)
  // A COLLAPSED caret spans exactly ONE block — its primary. A RANGE keeps the full
  // multi-block overlap span (D3). (See the surface note the code moved from.)
  const blockIds = (selectionType === 'caret')
    ? (primaryId ? [primaryId] : [])
    : span.map((b) => b.id).filter(Boolean)

  const blockKind = nodeBlockKind(primary)
  const range = { from: er.from, to: er.to }
  const label = labelFor(primary, selectionType, blockKind, selectedText, T)
  const target = resolveTarget(selectionType, blockKind, primaryId, blockIds, range, label)

  return {
    selectionType: selectionType,
    caret: sel.head,
    range: range,
    selectedText: selectedText,
    blockId: primaryId,
    blockIds: blockIds,
    blockKind: blockKind,
    ref: nodeRef(primary),
    target: target,
  }
}
