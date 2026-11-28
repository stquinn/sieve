// @ts-check
// chat-showcase.js — the SHOWCASE CHAT, as the JS suites hold it. It is read off
// the Go fixture's own content file
// (`sieve/block/processors/testdata/chat-showcase/`), so the chat drawn here is
// the one Go decodes and the one a seeded store opens: a plain exchange; a rich
// question (prose, a pasted code block, an attachment) answered richly (prose
// with inline code, a code block, a cited reference); an exchange whose job
// failed; and, last, one still pending.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import jsyaml from 'js-yaml'

/** @typedef {{id: string, kind: string, attrs: Record<string, any>}} ShowcaseExchange */

export class ChatShowcase {
  /** The chat the showcase IS. */
  static UUID = '0198c1a0-0002-7000-8000-000000000001'

  /** Where each part of the showcase sits in the chat's order. */
  static PART = Object.freeze({ PLAIN: 0, RICH: 1, FAILED: 2, PENDING: 3 })

  // vitest's root is frontend/, which process.cwd() matches at test time;
  // happy-dom's global URL shadows node's, so import.meta.url is unreliable here.
  static #FILE = path.resolve(process.cwd(), '../sieve/block/processors/testdata/chat-showcase', ChatShowcase.UUID + '.chat')

  /**
   * The chat's exchanges in order, each as the chat's provider hands one to a
   * lens: its id, its kind and the attr map Go stores.
   * @returns {ShowcaseExchange[]}
   */
  static exchanges() {
    const chat = /** @type {{kind: string, exchanges: Array<Record<string, any>>}} */ (jsyaml.load(readFileSync(ChatShowcase.#FILE, 'utf8')))
    return chat.exchanges.map((attrs) => ({ id: String(attrs.id), kind: 'ai-block', attrs }))
  }

  /**
   * One part of the showcase.
   * @param {number} part one of ChatShowcase.PART
   * @returns {ShowcaseExchange}
   */
  static exchange(part) {
    return ChatShowcase.exchanges()[part]
  }
}
