// @ts-check
// The host's InkContainerProvider over (model, DocumentService): a Digital
// Note's block read as any block is, its pages asked for over the container's
// channel, and its ink frames turned into the feed's events. Semantics are
// contract/ink-container-provider.js's.

import { ProviderAdapter } from './provider-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { InkFeed, InkTranscriptState } from '../contract/ink-container-provider.js'
import { DocumentFrame } from '../generated/protocol.js'

/** @typedef {import('../contract/ink-container-provider.js').InkPageAnswer} InkPageAnswer */
/** @typedef {import('../contract/ink-container-provider.js').InkOpeningResult} InkOpeningResult */
/** @typedef {import('../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../contract/ink-container-provider.js').InkLiveRecord} InkLiveRecord */
/** @typedef {import('../contract/ink-container-provider.js').InkTranscript} InkTranscript */

export class InkProviderAdapter extends ProviderAdapter {
  /** @type {import('./document-service.js').DocumentService} */ #documents

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(model, documentService) {
    super(model)
    if (!documentService || typeof documentService.inkPage !== 'function' || typeof documentService.observeInk !== 'function' ||
      typeof documentService.inkKeepDrawing !== 'function' ||
      typeof documentService.inkOpenOnTablet !== 'function' || typeof documentService.inkTranscript !== 'function' ||
      typeof documentService.inkDescribe !== 'function') {
      throw new ContractViolation('InkProviderAdapter: construct over the DocumentService')
    }
    this.#documents = documentService
  }

  /** @param {string} pageId @param {string} [renderer] @returns {Promise<InkPageAnswer>} */
  loadPage(pageId, renderer) {
    return this.#documents.inkPage(this.getUuid(), pageId, renderer)
      .then((answer) => /** @type {InkPageAnswer} */ (ProviderAdapter._frozenInPlace({ page: answer.page, drawing: answer.drawing, seq: answer.seq, key: answer.key })))
  }

  /** @param {string} pageId @param {string} key @param {string} drawing */
  keepDrawing(pageId, key, drawing) {
    this.#documents.inkKeepDrawing(this.getUuid(), pageId, key, drawing)
  }

  /** @param {string} pageId @returns {Promise<InkOpeningResult>} */
  openOnTablet(pageId) {
    return this.#documents.inkOpenOnTablet(this.getUuid(), pageId)
      .then((answer) => /** @type {InkOpeningResult} */ (ProviderAdapter._frozen({ outcome: answer.outcome, reason: answer.reason })))
  }

  /** @returns {Promise<void>} */
  refreshDescription() {
    return this.#documents.inkDescribe(this.getUuid())
  }

  /** @param {string} pageId @returns {Promise<InkTranscript>} */
  loadTranscript(pageId) {
    return this.#documents.inkTranscript(this.getUuid(), pageId).then((wire) => this.#transcript(pageId, wire))
  }

  /** @param {string} pageId @returns {Promise<InkTranscript>} */
  transcribePage(pageId) {
    return this.#documents.inkTranscribePage(this.getUuid(), pageId).then((wire) => this.#transcript(pageId, wire))
  }

  /** @param {string} pageId @returns {Promise<string>} */
  newDocumentFromTranscript(pageId) {
    return this.#documents.inkTranscriptDocument(this.getUuid(), pageId)
  }

  /**
   * @protected
   * @param {(event: Record<string, any>) => void} deliver
   * @returns {() => void}
   */
  _startFeed(deliver) {
    return this.#documents.observeInk(this.getUuid(), (frame) => {
      const event = this.#eventOf(frame)
      if (event) deliver(event)
    })
  }

  /**
   * The feed event an ink frame is; null for a frame that is none.
   * @param {Record<string, any>} frame @returns {InkFeedEvent|null}
   */
  #eventOf(frame) {
    switch (frame.type) {
      case DocumentFrame.INK_STROKE_ADDED:
        return { type: InkFeed.STROKE_ADDED, pageId: String(frame.pageId), seq: Number(frame.seq), stroke: frame.stroke }
      case DocumentFrame.INK_STROKE_REMOVED:
        return { type: InkFeed.STROKE_REMOVED, pageId: String(frame.pageId), seq: Number(frame.seq), strokeId: String(frame.strokeId) }
      case DocumentFrame.INK_LIVE:
        return { type: InkFeed.LIVE, records: (frame.records || []).map((/** @type {Record<string, any>} */ r) => this.#liveRecord(r)) }
      case DocumentFrame.INK_LIVE_PAGE:
        return frame.live === true
          ? { type: InkFeed.LIVE_PAGE, live: true, pageId: String(frame.pageId), view: frame.view ? String(frame.view) : null }
          : { type: InkFeed.LIVE_PAGE, live: false, pageId: null, view: null }
      case DocumentFrame.INK_LOG_RESTARTED:
        return { type: InkFeed.LOG_RESTARTED }
      case DocumentFrame.INK_TRANSCRIPT_CHANGED:
        return { type: InkFeed.TRANSCRIPT, transcript: this.#transcriptOf(String(frame.pageId), frame.transcript || {}) }
      default:
        return null
    }
  }

  /** A transcript as the wire carries it, as the contract's frozen InkTranscript.
   *  @param {string} pageId @param {Record<string, any>} wire @returns {InkTranscript} */
  #transcript(pageId, wire) {
    return /** @type {InkTranscript} */ (ProviderAdapter._frozen(this.#transcriptOf(pageId, wire)))
  }

  /** @param {string} pageId @param {Record<string, any>} wire @returns {InkTranscript} */
  #transcriptOf(pageId, wire) {
    return {
      pageId: pageId,
      state: String(wire.state || InkTranscriptState.NONE),
      key: String(wire.key || ''),
      blocks: (wire.blocks || []).map((/** @type {Record<string, any>} */ b) => ({
        id: String(b.id), kind: String(b.kind), attrs: Object.assign({}, b.attrs, { id: String(b.id) }),
      })),
      running: wire.running === true,
      available: wire.available === true,
      unavailable: String(wire.unavailable || ''),
      failed: String(wire.failed || ''),
    }
  }

  /** @param {Record<string, any>} r @returns {InkLiveRecord} */
  #liveRecord(r) {
    return {
      record: r.record,
      stroke: r.stroke || 0,
      tool: r.tool || null,
      widthClass: r.widthClass || 0,
      x: r.x || 0,
      y: r.y || 0,
      pressure: r.pressure || 0,
      tMillis: r.tMillis || 0,
      tiltX: r.tiltX || 0,
      tiltY: r.tiltY || 0,
    }
  }
}
