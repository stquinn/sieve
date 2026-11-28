// @ts-check
// The host's ChatContainerProvider over (model, DocumentService): a chat's
// exchanges read as the model holds them, a question asked and an unanswered
// exchange retried over the chat's channel, and the chat named now or by hand
// over its HTTP routes. Semantics are
// contract/chat-container-provider.js's. Like every adapter it writes nothing to
// the model: an exchange reaches the lens as the frames Go sends back.

import { ProviderAdapter } from './provider-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'

/** @typedef {import('../contract/container-provider.js').BlockData} BlockData */
/** @typedef {import('../contract/chat-container-provider.js').ChatQuestionBlock} ChatQuestionBlock */

export class ChatProviderAdapter extends ProviderAdapter {
  /** @type {import('./document-service.js').DocumentService} */ #documents

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(model, documentService) {
    super(model)
    if (!documentService || typeof documentService.chatAppendExchange !== 'function' || typeof documentService.retry !== 'function' ||
      typeof documentService.chatDescribe !== 'function' || typeof documentService.chatRename !== 'function') {
      throw new ContractViolation('ChatProviderAdapter: construct over the DocumentService')
    }
    this.#documents = documentService
  }

  /** @returns {ReadonlyArray<Readonly<BlockData>>} */
  getExchanges() {
    const exchanges = /** @type {Array<Readonly<BlockData>>} */ ([])
    for (const id of this.getOrder()) {
      const exchange = this.getBlock(id)
      if (exchange) exchanges.push(exchange)
    }
    return Object.freeze(exchanges)
  }

  /** @param {ReadonlyArray<ChatQuestionBlock>} question */
  requestAsk(question) {
    if (!Array.isArray(question) || question.length === 0) {
      console.warn('[chat-provider] requestAsk: a question holds at least one block, dropped')
      return
    }
    this.#documents.chatAppendExchange(this.getUuid(), question)
  }

  /** @param {string} exchangeId */
  requestRetry(exchangeId) {
    if (!this.getBlock(exchangeId)) {
      console.warn('[chat-provider] requestRetry: unknown exchange id, dropped', exchangeId)
      return
    }
    this.#documents.retry(this.getUuid(), exchangeId)
  }

  /** @returns {Promise<void>} */
  nameNow() { return this.#documents.chatDescribe(this.getUuid()) }

  /** @param {string} name @returns {Promise<void>} */
  rename(name) { return this.#documents.chatRename(this.getUuid(), String(name == null ? '' : name)) }
}
