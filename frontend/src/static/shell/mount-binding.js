// @ts-check
// mount-binding.js — MountBinding: one mounted container, from the host's side
// (issue #96 P4a; wired as the construction seam in P4b).
//
// The settled contract's mount sequence has four steps and a host verb for each:
//
//     model    = ensureModel(address)
//     provider = new ProviderAdapter(model, binding)
//     lens     = new NoteLens(provider)          ← the caller's, not this class's
//     provider.subscribe(lens)                   ← the lens does it at mount
//     lens.setSelectionListener(binding)         ← this object IS the listener
//
// This class owns the first two and the last, which is exactly the host's half.
// It never constructs a lens: which lens a container gets is a workspace
// decision, and a host object that picked one would be the composition root
// smuggled into the mount.
//
// It is thin on purpose. Everything with judgment in it lives on one side of the
// wall or the other; this is the seam, and a seam that accumulates behaviour is
// how the two sides grow back together.
//
// WHICH PROVIDER a container gets is decided here, from its kind, because the
// provider TYPE is the container's capability and the host is what knows it: a
// prompt is text and nothing else (WholeContentAdapter), a note is a block tree
// that can also project itself as text (BlockProviderAdapter). A lens declares
// which of those it demands by what its constructor asks for.

import { ContainerModelFeed } from '../container/container-model-feed.js'
import { ContainerBinding } from '../container/container-binding.js'
import { BlockProviderAdapter } from '../container/block-provider-adapter.js'
import { WholeContentAdapter } from '../container/whole-content-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'

export class MountBinding {
  /** @type {string} */ #uuid
  /** @type {import('../container/document-service.js').DocumentService} */ #documents
  /** @type {ContainerModelFeed} */ #feed
  /** @type {import('../container/container-model.js').ContainerModel} */ #model
  /** @type {ContainerBinding} */ #binding
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
    this.#binding = new ContainerBinding(uuid, documentService)
    this.#provider = kind === 'prompt'
      ? new WholeContentAdapter(this.#model, this.#binding)
      : new BlockProviderAdapter(this.#model, this.#binding)
  }

  /** @returns {string} */
  getUuid() { return this.#uuid }

  /**
   * The one business dependency a lens is constructed against. The model behind
   * it is #private all the way down, so handing this out hands out the read
   * surface and the verbs and nothing else.
   * @returns {WholeContentAdapter}
   */
  get provider() { return this.#provider }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Opens the container's live channel. The model was created in the constructor
   * and is already observing, so it folds every frame this channel delivers from
   * the first one.
   *
   * The delegate is the transport's own inbound routing, NOT a repaint path: the
   * lens hears about content through its subscription, and what is left here is
   * the traffic that is nobody's document truth (a server error, a stray reply).
   * @param {import('../container/container-transport.js').ChannelDelegate} delegate
   */
  openChannel(delegate) {
    this.#documents.open(this.#uuid, delegate)
    this.#channelOpen = true
  }

  /**
   * Loads the container. The load ANSWER seeds the model through the feed's own
   * subscription — this returns the typed shape only, for the caller that still
   * needs it (the host presents at open: the mode choice and the markdown body
   * are host concerns). Requires an open channel for a channel-bearing
   * container; a prompt pseudo-document answers over HTTP either way.
   * @returns {Promise<{body: string, blocks: object[], meta: {mode: string}, scroll: number, version: number}>}
   */
  load() { return this.#documents.load(this.#uuid) }

  /**
   * The server's clean whole-container export — the "Copy as Markdown" text.
   * A HOST verb: the menu that asks for it acts on the workspace, not through
   * the wall, and the filtering it applies (ai-blocks dropped, cards and clips
   * reduced to links) is Go's, not any lens's projection.
   * @param {string} [format]
   * @returns {Promise<string|null>}
   */
  exportAs(format = 'markdown') { return this.#binding.exportAs(format) }

  /**
   * Closes the channel and discards the model. After this the binding is spent:
   * a re-mount constructs a new one, because the provider a lens holds is bound
   * to the model this one discarded.
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

  // ── SelectionListener (the presence seam, flowing host-ward) ───────────────

  /**
   * Receives the mounted lens's selection/presence advertisement. The lens
   * registers this object with `lens.setSelectionListener(binding)`; the advert
   * is a broadcast, best-attempt, and this end judges nothing about it — it
   * stores the latest and re-publishes.
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
   * Deliberately the same signature as SieveTab.onSelectionUpdate, which is what
   * the shell's selection plumbing already consumes.
   * @param {(context: Readonly<any>) => void} listener
   * @returns {() => void} unsubscribe
   */
  onSelectionAdvert(listener) {
    if (typeof listener !== 'function') throw new ContractViolation('MountBinding.onSelectionAdvert: listener must be a function')
    this.#advertListeners.push(listener)
    return () => { this.#advertListeners = this.#advertListeners.filter((l) => l !== listener) }
  }

  /**
   * The most recent advert, or null before the lens has made one. This is the
   * PULL half the shell needs: the workspace synthesizes a republish on tab
   * activation by pulling the mount's current context.
   * @returns {Readonly<any>|null}
   */
  getSelectionContext() { return this.#lastAdvert }
}
