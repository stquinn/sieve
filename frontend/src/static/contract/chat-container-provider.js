// @ts-check
// What a host hands the lens of a chat: a list of exchanges that only grows.
// Each exchange is an ai-block, read as any block is; its attrs carry the
// `question` and the `answer` (each an ordered list of blocks), the `status` of
// the job answering it, `createdAt`, and `error` once it failed. Nothing edits,
// reorders or removes an exchange.
//
// A question asked arrives as a new exchange at the end, PENDING, and its answer
// a block at a time, each as an `onChanged` naming the exchange. The chat has no
// feed.

/**
 * One block of a question, as a composer authored it. A block its author already
 * named carries that name in `attrs.id`; one without is named by the host.
 * @typedef {{kind: string, attrs: Record<string, any>}} ChatQuestionBlock
 */

/**
 * The read minimum, the chat's exchanges, and the verbs a chat has.
 *
 * - `getExchanges` is every exchange the chat holds, in the chat's order, as
 *   frozen copies: `getOrder()` read through `getBlock()`.
 * - `requestAsk` asks `question` as a new exchange after the last. Void: the
 *   exchange arrives as an `onChanged` naming it, and an empty question asks
 *   nothing.
 * - `requestRetry` runs the job of an exchange that has no answer again. Void:
 *   the exchange arrives again PENDING. The host declines, silently, an exchange
 *   that has an answer, one being answered, and an id the chat does not hold.
 * - `nameNow` asks for the chat to be named now — its name, unless a person
 *   named it, and its summary, keywords and categories described again from its
 *   answered exchanges — and resolves once the host has accepted the request (one
 *   already under way included). It REJECTS with an Error whose message is the
 *   host's words, fit to show a person, when nothing could be asked: no AI is
 *   configured, the chat has no answer yet, or the host did not answer.
 * - `rename` gives the chat `name` by hand, kept by every later naming; a blank
 *   one hands naming back. It resolves once the chat is renamed and REJECTS with
 *   the host's words when it is not.
 *
 * A chat's new name reaches the workspace's tab and Chats item, not the lens.
 *
 * @typedef {import('./container-provider.js').ContainerProvider & {
 *   getExchanges: () => ReadonlyArray<Readonly<import('./container-provider.js').BlockData>>,
 *   requestAsk: (question: ReadonlyArray<ChatQuestionBlock>) => void,
 *   requestRetry: (exchangeId: string) => void,
 *   nameNow: () => Promise<void>,
 *   rename: (name: string) => Promise<void>,
 * }} ChatContainerProvider
 */

export {}
