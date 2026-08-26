// @ts-check
// What a HOST implements and hands a lens at mount, pre-bound to ONE container.
// Possession is authorization: a lens cannot remount itself, and only a host
// gesture re-targets.

/**
 * One block, as JSON-shaped data — a frozen copy, never a live reference.
 * @typedef {object} BlockData
 * @property {string} id
 * @property {string} kind
 * @property {Record<string, any>} attrs   the opaque kind payload; carries `id`
 * @property {string} [text]   the block's Go-serialized form, present only when the host had one; cannot be asked for or refreshed, and never travels back
 */

/**
 * @typedef {object} ContentEntry
 * @property {string} mimeType
 * @property {string} content
 * @property {Record<string, any>} [context]   where the entry came from as opposed to what it is (a picked file's name, the parent a transform ran inside); absent for a plain clipboard string
 */

/**
 * What a paste is, as DATA: one query, four kinds.
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
 * Outcome of one paste round trip. A declined paste surfaces no error.
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
 * Read-only minimum every mounted container offers, and EXACTLY what a
 * `?version={n}`-pinned mount returns. Reads are SYNC and return frozen copies —
 * never a round trip.
 *
 * @typedef {object} ContainerProvider
 * @property {() => string} getUuid
 * @property {() => string} getKind                    the container's kind as a DATA word ('note' today); affordances read it, nothing subclasses on it
 * @property {() => ReadonlyArray<string>} getOrder     child ids in container order
 * @property {(id: string) => Readonly<BlockData>|null} getBlock
 * @property {(listener: import('./container-update-listener.js').ContainerUpdateListener) => void} subscribe
 *   cues the listener with the whole container immediately: bootstrap IS the first `onChanged`
 * @property {(listener: import('./container-update-listener.js').ContainerUpdateListener) => void} unsubscribe
 */

/**
 * Adds block intents to the read-only minimum. Every `request*` verb is VOID: Go
 * may decline silently, and the only visible effect is a later `onChanged`.
 *
 * Anchoring is by BLOCK ID, never an index. `afterBlockId` omitted appends;
 * `null` means the front of the container; an id the container does not hold
 * appends. A block the lens already drew passes the UUIDv7 it minted as
 * `attrs.id`; one it has not drawn omits it.
 *
 * `requestSetOrder` states the COMPLETE child order rather than moving one block
 * relative to another, so a duplicate or late request is idempotent.
 *
 * `requestPersist` commits what the container already holds; `flush` hands over
 * one block's in-flight text. Neither implies the other.
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

/**
 * The whole-container-as-text extension. The projection is Go-serialized; never
 * re-implement serialization client-side.
 *
 *   getContents()      — the authoritative whole projection. On a container with
 *                        a live channel this IS the hand-over: Go starts treating
 *                        the text as the truth.
 *   setContents(text)  — hand the entirety back. Go RE-PARSES, and the deltas
 *                        arrive down `onChanged`. Resolves once Go has taken it.
 *   flushContents(text)— keep this buffer, do NOT re-parse. Never use
 *                        `setContents` for a half-typed buffer: re-parsing takes
 *                        Go out of verbatim mode mid-keystroke.
 *
 * @typedef {ContainerProvider & {
 *   getContents: () => Promise<string>,
 *   setContents: (text: string) => Promise<void>,
 *   flushContents: (text: string) => void,
 * }} WholeContentProvider
 */

export {}
