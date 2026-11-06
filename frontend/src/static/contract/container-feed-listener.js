// @ts-check
// The host → lens channel for what happens to a container that is not its state.

/**
 * One event of a container's feed: a frozen object, frozen all the way down,
 * whose `type` the container's kind defines, with that kind's fields beside it.
 * @typedef {Readonly<{type: string, [field: string]: any}>} ContainerFeedEvent
 */

/**
 * What a lens implements to hear a container's feed, registered through the
 * provider's `subscribeFeed`.
 *
 * - NEVER REPLAYED: a listener hears what happens from the moment it subscribes
 *   and nothing before it.
 * - NEVER PART OF A LOAD: the container's state is what the provider's reads
 *   answer, and no event changes an answer; what an event says is either
 *   ephemeral or a change the lens could also have read back.
 * - SAFE TO MISS: a lens that misses events loses nothing it cannot get again
 *   from the provider.
 * - IN ORDER: events arrive one at a time, in the order the host heard them.
 *
 * A kind with no feed never delivers an event.
 *
 * @typedef {object} ContainerFeedListener
 * @property {(event: ContainerFeedEvent) => void} onFeed
 */

export {}
