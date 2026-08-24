// @ts-check
// container-provider.js — the business half of the Lens↔Host wall (issue #96
// P2, the settled contract in issue comment 1694; the P4b vocabulary rulings in
// comment 1699). The provider hierarchy is what a HOST implements and hands a
// lens at mount; it is pre-bound to ONE container (possession = authorization —
// a lens cannot remount itself, only a host gesture re-targets).
//
// This module is a LEAF: it imports nothing, from `contract/` or anywhere
// else, so both sides of the wall (and a future IPC bridge) can depend on it
// without pulling in the other. Types only — nothing here runs.

/**
 * One block, as JSON-shaped data — a frozen copy, never a live reference.
 * Mirrors container/container-model.js's BlockNode field-for-field; redeclared
 * here rather than imported because this package imports nothing.
 *
 * A BLOCK IS BORN WITH ITS DURABLE IDENTITY, WHEREVER IT IS BORN (issue #96).
 * Ids are UUIDv7, and that is the whole point: a v7 is unique without
 * coordination, so whoever creates a block can name it. A block born in Go — a
 * paste, an AI answer, a transform — is named by `ident.New` there; a block born
 * in a LENS, which is prose typed into existence, is named by the lens's own
 * `ident.mint`. Go's role on that second path is not to mint but to VALIDATE:
 * well-formed, and not a name this container already uses. It refuses rather
 * than corrects, because a substituted id would leave the creator addressing a
 * block that no longer answers to it.
 *
 * There is therefore NO pending state, no transient handle, and nothing to
 * correlate: the block carries the same name on both sides from the first
 * keystroke, so `onChanged` stays `{blockIds, orderChanged}` and a lens
 * recognises an arrival it made by the plain id it chose.
 *
 * `text` is the block's own SERIALIZED form, present only when the host had it
 * to give (Go volunteers it when it creates a block). It is DERIVED — a
 * processor's job, never re-implemented client-side — so there is no way to ask
 * for it and no way to refresh it. Its one consumer is a whole-content lens,
 * which needs a single block's projection to fold an arrival into a verbatim
 * buffer. It is a field rather than an attr because it is not part of the block's
 * state: nothing patches it and it never travels back.
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
 * inside. A processor may require it — the attachment processor claims nothing
 * without a filename — so it is part of the entry rather than a separate
 * argument, and it is optional because a plain clipboard string has no provenance
 * to state.
 *
 * @typedef {object} ContentEntry
 * @property {string} mimeType
 * @property {string} content
 * @property {Record<string, any>} [context]
 */

/**
 * What a paste is, as DATA. One query, four kinds — mirroring the wire's own
 * "one frame, four kinds" (issue #96 comment 1699 ruling 4): "what should the
 * server make of this" is one question with one answer shape, and reading the
 * fields regardless of kind is how a discriminated union rots into a bag of
 * optional flags.
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
 * Outcome of one paste round trip — Go's `block.PasteResult` discriminated
 * union, abstracted at the facade, minus the transport noise (`kind`/`id`/
 * `rawYaml`/`error` are wire plumbing the facade does not surface; a created
 * block is announced through `onChanged` like any other arrival, and a declined
 * paste has no facade-visible error — the caller replays locally).
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
 * Read-only minimum every mounted container offers. A `@v{n}`-pinned mount (a
 * version viewer) returns EXACTLY this type — read-only is a type a host
 * hands out, not a flag on a richer one, because a pinned coordinate can never
 * legitimately accept a verb.
 *
 * Reads are SYNC and return frozen copies, answered by the nearest follower
 * model — never a round trip. In the in-process host that model is
 * `container/container-model.js`'s `ContainerModel`; across a future IPC
 * bridge it is a replica the bridge maintains, so this contract's shape never
 * has to change to cross a process — serialization discipline lives at the
 * `subscribe` stream, plain copies at these reads.
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
 * Adds block intents to the read-only minimum. Every `request*` verb is VOID:
 * Go may decline silently, and the only visible effect is a later `onChanged`
 * saying what changed — never that this verb is what changed it (see
 * container-update-listener.js — "there is no onAck", and no correlation
 * either). `paste` and `detectExtractions` are QUERIES — decisions/offers
 * only, never document content — so they answer with a Promise instead.
 *
 * Anchoring is by BLOCK ID, never an index: the host resolves `afterBlockId`
 * to a position by reading its own follower model. A lens never computes a
 * document position (see the repo-wide "backend is the document source of
 * truth" rule). `afterBlockId` OMITTED appends; `null` means the front of the
 * container; an id the container does not hold appends, because inventing a
 * position for a name nobody has is how a block lands where the user did not
 * point.
 *
 * A block the lens has ALREADY DRAWN names itself: `attrs.id` carries the
 * UUIDv7 it minted, and Go validates and adopts it (see BlockData). A block the
 * lens has not drawn simply omits it and Go mints.
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
// requestRemoveBlock exists because REMOVAL IS A CONTRACT VERB, not a side
// effect of some other edit. The alternative — a lens dropping a block by
// leaving it out of some larger statement of what the container should contain
// — would make deletion the one mutation with no verb of its own, and it would
// force every lens that can delete to be able to describe the WHOLE container.
// A lens says which block it wants gone, and learns it is gone the same way
// every other follower does: Go's `remove-block` echo reaching the fold.

// requestSetOrder states the container's COMPLETE child order rather than
// moving one block relative to another (issue #96 comment 1699 ruling 2). A
// whole order is idempotent — a duplicate or late request lands the container
// in the same place — and it is the shape `order-changed` echoes back, so the
// same statement travels in both directions. A lens that knows where one block
// should go knows the order it wants; expressing that as a move as well would
// be two mechanisms for one fact.

// requestPersist asks the container to reach disk NOW rather than on its own
// debounce (Mod+S, the flush before an AI ask, filing). It is DISTINCT from
// `flush`: flush hands over one block's in-flight text, persist commits
// whatever the container already holds, and a lens routinely wants one without
// the other.

// flush is deliberately UNPREFIXED: it hands lens-owned in-flight text to the
// host (the follower invariant's one sanctioned exception — a lens's own
// draft is the single piece of state that legitimately lives ahead of Go), not
// a request Go might decline. Naming it `requestFlush` would claim the same
// may-be-ignored semantics as the verbs above, which is false — a flush always
// lands.

/**
 * The whole-container-as-text extension (issue #96 comment 1699 ruling 3): the
 * markdown break-glass buffer's vocabulary, and the one the mode flip speaks.
 * A PROMPT's provider is this and nothing else, and it legally never cues —
 * nothing but the prompt's own lens ever mutates a prompt, so "no events" is
 * correct rather than a hole.
 *
 * The projection is DERIVED, Go-serialized (serialization stays a
 * `BlockProcessor` concern, never re-implemented client-side).
 *
 * Three members, because Go really has three verbs here and collapsing them
 * would break an invariant:
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
