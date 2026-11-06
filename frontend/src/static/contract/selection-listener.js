// @ts-check
// The presence seam: the ONE thing that flows host-ward across the wall.
// Registered ON the lens, because the HOST is the consumer.
//
// The advertisement is a BROADCAST: a lens emits everything it knows about its
// own selection state and lets each consumer judge relevance. Fields are
// nullable because lenses differ in what they have. A lens with no selection
// still advertises; `docUuid` plus any single value is a valid advert.

/**
 * The resolved Ask AI target: what a command with no explicit selection acts on.
 * @typedef {object} AiTarget
 * @property {'block'|'selection'|'document'} kind
 * @property {string} ref     block id / ref chain / 'doc'
 * @property {{from: number, to: number}|null} range   null for a document target
 * @property {string} label   finished friendly display noun/snippet
 */

/**
 * One of the host's text marks together with the block it was pushed for and
 * the feature that drew it. A mark alone names a stretch of SOME block's text;
 * an advertisement is document-wide, so what it carries has to say which block.
 * The feature is the one field the wire mark lacks — it rides the frame
 * envelope — and without it a consumer cannot tell a producer's marks from
 * another's.
 * @typedef {import('./container-update-listener.js').SieveTextMark & {blockId: string, feature: string}} SelectedTextMark
 */

/**
 * The lens's selection/focus/caret advertisement — JSON-shaped, with no PM node
 * and no DOM element in it. `caret`/`range` are the LENS's own document
 * coordinate: read them for display and decisions only, never to construct a
 * mutation. The backend is the document's sole position authority.
 *
 * @typedef {object} SelectionContext
 * @property {'none'|'caret'|'range'|'block'} selectionType
 * @property {number|null} caret
 * @property {{from: number, to: number}|null} range
 * @property {string|null} selectedText
 * @property {string|null} blockId       primary block the cursor/selection sits in/on
 * @property {string[]} blockIds         all blocks the range spans (superset of [blockId]); [] when 'none'
 * @property {string|null} blockKind
 * @property {string|null} ref           block ref/anchor (ai-block re-chain)
 * @property {'editor'|'block-inner'|'ask'|'markdown'|'outside'} focusZone
 * @property {AiTarget} target
 * @property {number|null} scroll        viewport scroll position
 * @property {object|null} blockCursor
 *   caret inside a block whose inner editor is not ProseMirror. Opaque: a host
 *   treats it as inert data and never inspects it.
 * @property {ReadonlyArray<SelectedTextMark>} [textMarks]
 *   the marks the lens is DRAWING that this selection sits on — EVERY feature's,
 *   one flat list, each stamped with the feature that drew it, so a consumer
 *   filters rather than assuming what it finds there. Optional the way
 *   `onMarksChanged` is: a lens with nowhere to draw a mark advertises none. A
 *   mark here has resolved in what the lens draws, so an affordance may act on
 *   it; empty means the selection sits on none. Caret-class — it moves with the
 *   caret, so it never on its own makes an advertisement worth pushing.
 * @property {string} docUuid
 *   the emitting lens's container uuid, so a host aggregating advertisements
 *   from several mounted lenses can attribute each one without side-channel
 *   knowledge.
 */

/**
 * The host's registration surface. Presence, not a request/reply pair: every
 * host affordance acting on "what's selected" reads the advertisement alone.
 *
 * @typedef {object} SelectionListener
 * @property {(context: Readonly<SelectionContext>) => void} onSelectionChanged
 */

export {}
