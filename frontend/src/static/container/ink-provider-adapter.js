// @ts-check
// The host's InkContainerProvider over (model, DocumentService): a Digital
// Note's block read as any block is, its pages asked for over the container's
// channel, and its ink frames turned into the feed's events. Semantics are
// contract/ink-container-provider.js's.

import { ProviderAdapter } from './provider-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { InkFeed } from '../contract/ink-container-provider.js'
import { DocumentFrame } from '../generated/protocol.js'

/** @typedef {import('../contract/ink-container-provider.js').InkPageAnswer} InkPageAnswer */
/** @typedef {import('../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../contract/ink-container-provider.js').InkLiveRecord} InkLiveRecord */

export class InkProviderAdapter extends ProviderAdapter {
  /** @type {import('./document-service.js').DocumentService} */ #documents

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(model, documentService) {
    super(model)
    if (!documentService || typeof documentService.inkPage !== 'function' || typeof documentService.observeInk !== 'function') {
      throw new ContractViolation('InkProviderAdapter: construct over the DocumentService')
    }
    this.#documents = documentService
  }

  /** @param {string} pageId @returns {Promise<InkPageAnswer>} */
  loadPage(pageId) {
    return this.#documents.inkPage(this.getUuid(), pageId)
      .then((answer) => /** @type {InkPageAnswer} */ (ProviderAdapter._frozen({ page: answer.page, seq: answer.seq })))
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
        return { type: InkFeed.LIVE_PAGE, live: frame.live === true, pageId: frame.live === true ? String(frame.pageId) : null }
      case DocumentFrame.INK_LOG_RESTARTED:
        return { type: InkFeed.LOG_RESTARTED }
      default:
        return null
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
