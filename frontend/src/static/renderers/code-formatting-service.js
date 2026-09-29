// @ts-check
// The one thing a menu asks to pretty-print source.
//
// It is itself a Formatter, composed over an ORDERED list of them: the first
// whose `supports` answers true for the language is the one that formats. That
// order is the seam a second formatter joins on — a Go-language formatter backed
// by gofmt, or an LLM one — without a menu or an action changing.
//
// IT CANONICALISES THE LANGUAGE FIRST, because a fence carries whatever its
// author typed after the backticks. The alias table mirrors `lang.Canonical-
// Languages` for the languages in scope, so a ```js fence and a ```yml one reach
// the same formatters a `javascript` and a `yaml` block do. Nothing below it
// sees an alias.

/** Aliases to their canonical name, for the languages formatting covers.
 *  @type {Readonly<Record<string, string>>} */
const ALIASES = Object.freeze({
  js: 'javascript',
  yml: 'yaml',
})

/** Rejected by `format` when no formatter offers the language. Named so a caller
 *  can tell "nothing can format this" from "this did not parse". */
export class UnsupportedLanguageError extends Error {
  /** @type {string} the canonical language nothing offered. */
  language

  /** @param {string} language */
  constructor(language) {
    super(`No formatter supports the language "${language}"`)
    this.name = 'UnsupportedLanguageError'
    this.language = language
  }
}

/** @implements {import('./formatter.js').Formatter} */
export class CodeFormattingService {
  /** @type {readonly import('./formatter.js').Formatter[]} */
  #formatters

  /** @param {import('./formatter.js').Formatter[]} formatters
   *   in preference order; the first that supports a language answers for it. */
  constructor(formatters) {
    this.#formatters = Object.freeze((formatters || []).slice())
  }

  /** The canonical name of `language`, which may be an alias or already
   *  canonical. @param {string} language @returns {string} */
  canonical(language) {
    const name = String(language || '').trim().toLowerCase()
    return ALIASES[name] || name
  }

  /** @param {string} language @returns {boolean} */
  supports(language) {
    return !!this.#formatterFor(this.canonical(language))
  }

  /** @returns {readonly string[]} every language any formatter offers. */
  supportedLanguages() {
    /** @type {string[]} */ const all = []
    for (const f of this.#formatters) {
      for (const l of f.supportedLanguages()) if (!all.includes(l)) all.push(l)
    }
    return Object.freeze(all)
  }

  /** @param {string} language @param {string} source @returns {Promise<string>} */
  format(language, source) {
    const name = this.canonical(language)
    const formatter = this.#formatterFor(name)
    if (!formatter) return Promise.reject(new UnsupportedLanguageError(name))
    return formatter.format(name, source)
  }

  /** @param {string} canonical @returns {import('./formatter.js').Formatter|null} */
  #formatterFor(canonical) {
    if (!canonical) return null
    for (const f of this.#formatters) if (f.supports(canonical)) return f
    return null
  }
}
