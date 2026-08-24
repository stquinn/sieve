// @ts-check
// selection-listener.js — the presence seam: the ONE thing that flows
// host-ward across the wall. Registered ON the lens (`lens.setSelectionListener`),
// not the other way round, because the HOST is the consumer here ("the
// workspace subscribes to the editor" — issue #96 comment 1694).
//
// The field set is DERIVED from today's lens/selection-model.js
// SelectionContext, cross-checked against its real shell consumers
// (shell/target-chips.js, shell/ask-panel.js, shell/workspace.js) rather than
// invented.
//
// Doctrine (architect ruling, #96): the advertisement is a BROADCAST — the
// lens emits everything it knows about its own selection/presence state, and
// relevance is each consumer's judgment at read time. The contract never
// trims fields on a guess about who consumes them; it only requires that
// every field be JSON-shaped. The advert is BEST-ATTEMPT anchored on
// identity: identity (docUuid) plus any single value is already a valid
// advert — a lens with no current selection advertises 'none', and a lens
// that cannot select at all still advertises. The mandatory core may grow
// as consumers prove needs; what never changes is that absence of a
// best-attempt field is a diminished advert, not an error. Fields are
// nullable/optional because lenses differ in what they have, never because
// the contract polices what is sent.
//
// Leaf module: types only, nothing runs.

/**
 * The resolved Ask AI target — what a command with no explicit selection acts
 * on. Mirrors selection-model.js's `AiTarget` verbatim.
 * @typedef {object} AiTarget
 * @property {'block'|'selection'|'document'} kind
 * @property {string} ref     block id / ref chain / 'doc'
 * @property {{from: number, to: number}|null} range   null for a document target
 * @property {string} label   finished friendly display noun/snippet
 */

/**
 * The lens's selection/focus/caret advertisement — JSON-shaped, no PM node,
 * no DOM element anywhere in it. `caret`/`range` are the LENS's own document
 * coordinate (today, a ProseMirror position): the host reads them for display
 * and decisions only and must never use them to construct a mutation —
 * mutations are `request*` verbs on the provider, and the backend remains the
 * document's sole position authority.
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
 * @property {number|null} scroll
 *   viewport scroll position (workspace.js persists it at tab-deactivation)
 * @property {object|null} blockCursor
 *   caret inside a block whose inner editor is not ProseMirror — a forward
 *   seam no shipped block populates yet. Opaque: a host treats it as inert
 *   data, never inspects it.
 * @property {string} docUuid
 *   the emitting lens's container uuid — the advert's identity anchor.
 *   Makes the context self-describing, so a consumer aggregating
 *   advertisements from several mounted lenses can attribute each one
 *   without side-channel knowledge.
 */

/**
 * The host's registration surface. ONE method — presence, not a request/reply
 * pair — because the host never introspects the lens's DOM or PM state: every
 * host affordance acting on "what's selected" reads the advertisement alone.
 *
 * Forwarded host chords (the interaction policy's forward-to-host disposition,
 * #71's prepared ground) are NOT yet a field or method here — they land when
 * #71 ships, as either a second method or a discriminated event on this one.
 *
 * @typedef {object} SelectionListener
 * @property {(context: Readonly<SelectionContext>) => void} onSelectionChanged
 */

export {}
