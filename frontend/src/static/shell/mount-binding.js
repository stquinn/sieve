// @ts-check
// mount-binding.js — MountBinding: one mounted container, from the host's side.
// One binding holds ONE uuid: it owns that container's model, its channel and
// the single provider a lens is constructed against, and it IS the lens's
// selection listener. It never constructs a lens — which lens a container gets
// is a workspace decision. A closed binding is spent; a re-mount builds a new one.
//
// WHICH PROVIDER a container gets is decided here, from its kind, because the
// provider TYPE is the container's capability and the host is what knows it: a
// prompt is text and nothing else (WholeContentAdapter), a note is a block tree
// that can also project itself as text (BlockProviderAdapter). A lens declares
// which of those it demands by what its constructor asks for.

import { ContainerModelFeed } from '../container/container-model-feed.js'
import { BlockProviderAdapter } from '../container/block-provider-adapter.js'
import { WholeContentAdapter } from '../container/whole-content-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'

/** The outcome a write that never reached the wire reports, spelled as the ack
 *  spells its own failure — a caller reads one word, not two. */
const REPLACE_FAILED = 'error'

export class MountBinding {
  /** @type {string} */ #uuid
  /** @type {import('../container/document-service.js').DocumentService} */ #documents
  /** @type {ContainerModelFeed} */ #feed
  /** @type {import('../container/container-model.js').ContainerModel} */ #model
  /** @type {WholeContentAdapter} */ #provider
  /** @type {Array<(context: Readonly<any>) => void>} */ #advertListeners = []
  /** @type {Readonly<any>|null} */ #lastAdvert = null
  /** @type {boolean} */ #channelOpen = false

  /**
   * @param {string} uuid
   * @param {import('../container/document-service.js').DocumentService} documentService
   * @param {ContainerModelFeed} feed
   *   shared across mounts: one feed per workspace, one model per container
   * @param {string} [kind] the container's kind as a DATA word ('note' / 'prompt')
   */
  constructor(uuid, documentService, feed, kind) {
    if (!uuid) throw new ContractViolation('MountBinding: uuid is required')
    if (!documentService) throw new ContractViolation('MountBinding: construct over the DocumentService')
    if (!(feed instanceof ContainerModelFeed)) throw new ContractViolation('MountBinding: construct over a ContainerModelFeed')
    this.#uuid = uuid
    this.#documents = documentService
    this.#feed = feed
    this.#model = feed.open(uuid, kind)
    this.#provider = kind === 'prompt'
      ? new WholeContentAdapter(this.#model, documentService)
      : new BlockProviderAdapter(this.#model, documentService)
  }

  /** @returns {string} */
  getUuid() { return this.#uuid }

  /**
   * The one business dependency a lens is constructed against. The model behind
   * it is #private all the way down, so this hands out the read surface and the
   * verbs and nothing else.
   * @returns {WholeContentAdapter}
   */
  get provider() { return this.#provider }

  /**
   * Opens the container's live channel. The model already observes from the
   * constructor, so it folds every frame from the first. The delegate receives
   * the transport's own inbound routing, NOT a repaint path — the lens hears
   * about content through its subscription.
   * @param {import('../container/container-transport.js').ChannelDelegate} delegate
   */
  openChannel(delegate) {
    this.#documents.open(this.#uuid, delegate)
    this.#channelOpen = true
  }

  /**
   * Loads the container. The load ANSWER seeds the model through the feed's own
   * subscription; this returns the typed shape only, for the host that presents
   * at open. Requires an open channel for a channel-bearing container.
   * @returns {Promise<{body: string, blocks: object[], meta: {mode: string}, scroll: number, version: number}>}
   */
  load() { return this.#documents.load(this.#uuid) }

  /**
   * The server's clean whole-container export — the "Copy as Markdown" text. Its
   * filtering (ai-blocks dropped, cards and clips reduced to links) is Go's.
   * @param {string} [format]
   * @returns {Promise<string|null>}
   */
  exportAs(format = 'markdown') { return this.#documents.exportAs(this.#uuid, format) }

  /**
   * Switches a text-service feature on or off for THIS container, carrying what
   * the feature is to work with. Host chrome — a find bar, a toggle — is what
   * owns a feature's lifecycle, so the switch is a host verb and never one of
   * the provider's: a lens draws what a feature found and does not decide that it
   * runs.
   * @param {string} feature @param {boolean} enabled
   * @param {Record<string, any>} [parameters]
   */
  setFeature(feature, enabled, parameters) { this.#documents.setFeature(this.#uuid, feature, enabled, parameters) }

  /**
   * Writes what belongs in a marked run's place, and RESOLVES WITH THE OUTCOME.
   *
   * It is the same lane and the same mapping the provider's `requestReplaceText`
   * takes; what differs is that this one answers. A provider verb is void by
   * contract — a lens acts and reads the result as an ordinary container change
   * — but chrome that disarms a button until the write settles needs to be told
   * when it did, and `ok` / `stale` / `error` is that telling.
   *
   * A mark on a block this container no longer holds resolves as `error`: the
   * write did not happen, which is what a caller gating on the answer needs to
   * hear, and the marks that follow are what say what is really there.
   * @param {Readonly<import('../contract/container-update-listener.js').SieveTextMark> & {blockId?: string}} mark
   * @param {string} replacement
   * @returns {Promise<string>} the outcome word
   */
  replaceText(mark, replacement) {
    if (!mark || !this.#model.getBlock(mark.blockId || '')) return Promise.resolve(REPLACE_FAILED)
    return this.#documents.replaceText(this.#uuid, mark, replacement)
  }

  /**
   * Closes the channel and discards the model. After this the binding is spent:
   * the provider a lens holds is bound to the model this one discarded.
   */
  close() {
    if (this.#channelOpen) {
      this.#documents.close(this.#uuid)
      this.#channelOpen = false
    }
    this.#feed.close(this.#uuid)
    this.#advertListeners = []
    this.#lastAdvert = null
  }

  /**
   * Receives the mounted lens's selection/presence advertisement. This end judges
   * nothing about it — it stores the latest and re-publishes.
   * @param {Readonly<import('../contract/selection-listener.js').SelectionContext>} context
   */
  onSelectionChanged(context) {
    this.#lastAdvert = context
    for (const listener of this.#advertListeners) {
      try { listener(context) } catch (e) { console.error('[mount-binding] selection advert listener threw', e) }
    }
  }

  /**
   * Subscribes to this mount's selection adverts; returns an unsubscribe.
   * @param {(context: Readonly<any>) => void} listener
   * @returns {() => void} unsubscribe
   */
  onSelectionAdvert(listener) {
    if (typeof listener !== 'function') throw new ContractViolation('MountBinding.onSelectionAdvert: listener must be a function')
    this.#advertListeners.push(listener)
    return () => { this.#advertListeners = this.#advertListeners.filter((l) => l !== listener) }
  }

  /**
   * The most recent advert, or null before the lens has made one — the PULL half
   * the shell needs to republish on tab activation.
   * @returns {Readonly<any>|null}
   */
  getSelectionContext() { return this.#lastAdvert }
}
