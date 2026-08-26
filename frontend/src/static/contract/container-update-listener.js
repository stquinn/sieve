// @ts-check
// The wall's ONE inbound channel.

/**
 * What changed in one fold step, as JSON-shaped data.
 * @typedef {object} ContainerChange
 * @property {ReadonlyArray<string>} blockIds   ids whose node arrived, changed or left
 * @property {boolean} orderChanged
 */

/**
 * The single method a lens implements to consume container state. Emitted
 * POST-FOLD, so the handler always reads consistent model state.
 *
 * ORIGIN-BLIND: a lens's own echo, another lens's edit, an AI job and the file
 * watcher arrive here identically, with no thread back to "did I cause this". A
 * lens is told that A change happened; it re-reads and paints.
 *
 * There is no `onAck`. A verb Go declines changes nothing, so nothing fires;
 * failures surface as host errors or as block-attr status changes.
 *
 * @typedef {object} ContainerUpdateListener
 * @property {(change: Readonly<ContainerChange>) => void} onChanged
 */

export {}
