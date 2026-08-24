// @ts-check
// container-update-listener.js — the wall's ONE inbound channel: the facade
// shape of container/container-model.js's ContainerUpdateListener, redeclared
// here (not imported) because contract/ imports nothing.
//
// Leaf module: types only, nothing runs.

/**
 * What changed in one fold step, as JSON-shaped data.
 * @typedef {object} ContainerChange
 * @property {ReadonlyArray<string>} blockIds   ids whose node arrived, changed or left
 * @property {boolean} orderChanged
 */

/**
 * The single method a lens implements to consume container state. Emitted
 * POST-FOLD, so the handler always reads consistent model state, never
 * mid-mutation.
 *
 * ORIGIN-BLIND by construction: a lens's own echo, another lens's edit, an AI
 * job and the file watcher all arrive through this one method and look
 * identical — and there is no thread back to "did I cause this", by design. A
 * lens asked for a change and is told that A change happened; it re-reads and
 * paints. Request correlation exists only in the transport far below this wall,
 * where it settles a promise; carrying it up here would make a lens's repaint
 * depend on its own origin, which is the one thing this listener refuses.
 *
 * There is NO `onAck`: effects ARE the ack. A verb Go declines changes
 * nothing, so nothing fires; failures surface as host-level errors or as
 * block-attr status changes through the ordinary job pattern, never as a
 * distinct acknowledgment message on this listener.
 *
 * @typedef {object} ContainerUpdateListener
 * @property {(change: Readonly<ContainerChange>) => void} onChanged
 */

export {}
