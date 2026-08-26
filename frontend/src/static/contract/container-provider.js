// @ts-check
// The business half of the Lens↔Host wall. The provider hierarchy is what a HOST
// implements and hands a lens at mount, pre-bound to ONE container: possession is
// authorization, so a lens cannot remount itself and only a host gesture
// re-targets.
//
// This module is a LEAF — it imports nothing — so both sides of the wall can
// depend on it without pulling in the other. Types only; nothing here runs.

/**
 * One block, as JSON-shaped data — a frozen copy, never a live reference.
 * Mirrors container/container-model.js's BlockNode field-for-field; redeclared
 * here rather than imported because this package imports nothing.
 *
 * A BLOCK IS BORN WITH ITS DURABLE IDENTITY, WHEREVER IT IS BORN. Ids are
 * UUIDv7, unique without coordination, so whoever creates a block names it: Go
 * mints for a block it creates, a lens mints for prose typed into existence. On
 * that second path Go VALIDATES rather than mints — well-formed, and not a name
 * this container already uses — and refuses rather than corrects, because a
 * substituted id would leave the creator addressing a block that no longer
 * answers to it.
 *
 * There is therefore no pending state, no transient handle and nothing to
 * correlate: the block carries the same name on both sides from the first
 * keystroke, and a lens recognises an arrival it made by the id it chose.
 *
 * `text` is the block's own SERIALIZED form, present only when the host had one
 * to give. It is derived Go-side, so there is no way to ask for it and no way to
 * refresh it; its one consumer is a whole-content lens folding an arrival into a
 * verbatim buffer. Nothing patches it and it never travels back.
 *
 * @typedef {object} BlockData
 * @property {string} id
 * @property {string} kind
 * @property {Record<string, any>} attrs   the opaque kind payload; carries `id`
 * @property {string} [text]               the block's serialized form, when the host had one
 */

/**
 * One clipboard/drop/composed entry — the same shape the existing paste/extract
 * wire already carries (Go's `block.ContentEntry`).
 *
 * `context` is what an entry knows about WHERE IT CAME FROM, as opposed to what
 * it is: the filename of a picked file, the parent a transform was invoked
 * inside. A processor may require it — the reference processor claims a dropped
 * file only when it carries a filename — and it is absent for a plain clipboard
 * string.
 *
 * @typedef {object} ContentEntry
 * @property {string} mimeType
 * @property {string} content
 * @property {Record<string, any>} [context]
 */

/**
 * What a paste is, as DATA: one query, four kinds. Read the fields for the kind
 * the payload declares — reading them regardless of kind is how a discriminated
 * union rots into a bag of optional flags.
 *
 * - `smart`            — a clipboard the page could read; `entries` is it.
 * - `slice`            — a multi-block Sieve selection; `slice` is [][]ContentEntry.
 * - `native-drop`      — a file drop landed; `entries` is the page's readable
 *                        text, a HINT the server consults only when the OS-level
 *                        drop bucket misses it.
 * - `native-clipboard` — a clipboard the page CANNOT read at all (the empty
 *                        `DataTransfer` WebKitGTK hands over for a desktop
 *                        screenshot). It carries no data, and that emptiness IS
 *                        the payload — the server reads the clipboard itself.
 *
 * @typedef {{kind: 'smart', entries: ContentEntry[]}
 *   | {kind: 'slice', slice: ContentEntry[][]}
 *   | {kind: 'native-drop', entries: ContentEntry[]}
 *   | {kind: 'native-clipboard'}} PastePayload
 */

/**
 * Outcome of one paste round trip — Go's `block.PasteResult`, abstracted at the
 * facade. A created block is announced through `onChanged` like any other
 * arrival, and a declined paste surfaces no error: the caller replays locally.
 *
 * - `block`   — a block was created server-side; nothing further to do here.
 * - `content` — Go composed a fragment for the caret; insert `content`.
 * - `none`    — not a Sieve concern; the caller replays the clipboard natively.
 *
 * @typedef {object} PasteDecision
 * @property {'block'|'content'|'none'} outcome
 * @property {string} [content]   present only when outcome === 'content'
 */

/**
 * One kind Go can extract/transform a source block's content into, and the
 * operations it supports for that kind.
 * @typedef {object} ExtractionOffer
 * @property {string} kind
 * @property {string[]} actions
 */

/**
 * Read-only minimum every mounted container offers. A `?version={n}`-pinned
 * mount returns EXACTLY this type: read-only is a type a host hands out, never a
 * flag on a richer one, because a pinned coordinate cannot accept a verb.
 *
 * Reads are SYNC and return frozen copies, answered by the nearest follower
 * model — never a round trip.
 *
 * @typedef {object} ContainerProvider
 * @property {() => string} getUuid
 * @property {() => string} getKind                    the container's kind as a DATA word ('note' today) — affordances read it, nothing subclasses on it
 * @property {() => ReadonlyArray<string>} getOrder     child ids in container order
 * @property {(id: string) => Readonly<BlockData>|null} getBlock
 * @property {(listener: import('./container-update-listener.js').ContainerUpdateListener) => void} subscribe
 *   registers the listener and cues it with the whole container immediately — bootstrap IS the first `onChanged`
 * @property {(listener: import('./container-update-listener.js').ContainerUpdateListener) => void} unsubscribe
 */

/**
 * Adds block intents to the read-only minimum. Every `request*` verb is VOID: Go
 * may decline silently, and the only visible effect is a later `onChanged`
 * saying what changed — never that this verb is what changed it. `paste` and
 * `detectExtractions` are QUERIES — decisions and offers, never document content
 * — so they answer with a Promise instead.
 *
 * Anchoring is by BLOCK ID, never an index: a lens never computes a document
 * position, and the host resolves `afterBlockId` against its own follower model.
 * `afterBlockId` omitted appends; `null` means the front of the container; an id
 * the container does not hold appends.
 *
 * A block the lens has ALREADY DRAWN names itself — `attrs.id` carries the
 * UUIDv7 it minted, and Go validates and adopts it (see BlockData). A block the
 * lens has not drawn omits it and Go mints.
 *
 * @typedef {ContainerProvider & {
 *   requestAddBlock: (kind: string, attrs: Record<string, any>, afterBlockId?: string|null) => void,
 *   requestSetBlock: (blockId: string, patch: Record<string, any>) => void,
 *   requestRemoveBlock: (blockId: string) => void,
 *   requestSetOrder: (order: ReadonlyArray<string>) => void,
 *   requestTransform: (blockId: string, targetKind: string, operation: string, entries: ContentEntry[]) => void,
 *   requestRetry: (blockId: string) => void,
 *   requestPersist: () => void,
 *   paste: (payload: PastePayload, afterBlockId: string|null) => Promise<PasteDecision>,
 *   detectExtractions: (sourceKind: string, entries: ContentEntry[]) => Promise<ExtractionOffer[]>,
 *   flush: (blockId: string, text: string) => void,
 * }} BlockContainerProvider
 */
// requestRemoveBlock: REMOVAL IS A CONTRACT VERB. A lens says which block it
// wants gone and learns it is gone the way every other follower does — Go's
// `remove-block` echo reaching the fold.

// requestSetOrder states the container's COMPLETE child order rather than moving
// one block relative to another. A whole order is idempotent — a duplicate or
// late request lands the container in the same place — and it is the shape
// `order-changed` echoes back.

// requestPersist asks the container to reach disk NOW rather than on its own
// debounce (Mod+S, the flush before an AI ask, filing). It is DISTINCT from
// `flush`: flush hands over one block's in-flight text, persist commits whatever
// the container already holds.

// flush is UNPREFIXED because it always lands: it hands lens-owned in-flight
// text to the host — a lens's own draft is the one piece of state that
// legitimately lives ahead of Go — rather than making a request Go may decline.

/**
 * The whole-container-as-text extension: the markdown break-glass buffer's
 * vocabulary, and the one the mode flip speaks. A PROMPT's provider is this and
 * nothing else, and it legally never cues, because nothing but the prompt's own
 * lens ever mutates a prompt.
 *
 * The projection is DERIVED and Go-serialized; serialization is never
 * re-implemented client-side.
 *
 * Three members, because collapsing any two would break an invariant:
 *
 *   getContents()      — the authoritative whole projection. On a container
 *                        with a live channel this IS the hand-over: Go answers
 *                        with the serialized document and starts treating the
 *                        text as the truth, which is exactly what a caller
 *                        asking for the whole thing is doing.
 *   setContents(text)  — hand the entirety back. Go RE-PARSES it, resumes
 *                        treating the block tree as the truth, and the
 *                        resulting deltas arrive down the ONE inbound path
 *                        (`onChanged`). Resolves when Go has taken it, so a
 *                        caller that must not tear its view down until then
 *                        (the mode flip's stay-on-failure) can wait.
 *   flushContents(text)— the in-flight handoff, `flush` scaled to the whole
 *                        container: here is my current buffer, keep it, do NOT
 *                        re-parse. It is what a whole-content lens's typing
 *                        debounce ends at, and it is separate from
 *                        `setContents` because re-parsing a half-typed buffer
 *                        would take Go out of verbatim mode mid-keystroke.
 *
 * @typedef {ContainerProvider & {
 *   getContents: () => Promise<string>,
 *   setContents: (text: string) => Promise<void>,
 *   flushContents: (text: string) => void,
 * }} WholeContentProvider
 */

export {}
