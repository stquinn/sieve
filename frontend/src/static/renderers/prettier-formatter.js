// @ts-check
// The Formatter backed by Prettier, running in the browser.
//
// Prettier is vendored as one ESM bundle (`vendor/prettier.js`, built by
// `npm run bundle:prettier`) and LOADED ON THE FIRST FORMAT — it is ~890 KB of
// JS plus ~670 KB of WebAssembly for the Java parser, and nothing in the startup
// path needs it. The load is a dynamic `import()` held as one Promise, so a
// second Format never fetches it again.
//
// Standalone Prettier reads no `.prettierrc`, so every option is passed on every
// call and the per-language table below IS the house style.
//
// JSON IS FORMATTED BY TWO PARSERS, in this order: `json-stringify` expands every
// object and array the way an IDE would and reproduces numbers exactly as
// written, but rejects comments; `json` tolerates comments but packs short
// objects onto one line and rewrites `1.50` to `1.5`. Only the second can read a
// commented file, so it is the fallback and its error is the one reported.

/** Where the vendored bundle sits, as the app serves it. */
const VENDOR_URL = '/ui/static/vendor/prettier.js'

/** House style, per language. Frozen: these are read, never adjusted per call.
 *  @type {Readonly<Record<string, Readonly<object>>>} */
const OPTIONS = Object.freeze({
  json:       Object.freeze({ parser: 'json-stringify', tabWidth: 2 }),
  yaml:       Object.freeze({ parser: 'yaml', tabWidth: 2, proseWrap: 'preserve' }),
  javascript: Object.freeze({ parser: 'babel', tabWidth: 2, semi: true, singleQuote: false, trailingComma: 'all' }),
  java:       Object.freeze({ parser: 'java', tabWidth: 4 }),
})

/** The options every language shares. */
const COMMON = Object.freeze({ printWidth: 100, useTabs: false, endOfLine: 'lf' })

/** The parser that reads JSON with comments in it, when OPTIONS' first choice
 *  has refused the source. */
const JSON_WITH_COMMENTS = Object.freeze({ parser: 'json', tabWidth: 2 })

const LANGUAGES = Object.freeze(Object.keys(OPTIONS))

/** @typedef {{format: (source: string, options: object) => Promise<string>, plugins: any[]}} PrettierBundle */

/** @implements {import('./formatter.js').Formatter} */
export class PrettierFormatter {
  /** @type {() => Promise<PrettierBundle>} */
  #loader

  /** @type {Promise<PrettierBundle>|null} the one in-flight or settled load. */
  #bundle = null

  /**
   * @param {() => Promise<PrettierBundle>} [loader]
   *   how to reach Prettier. Defaults to importing the vendored bundle; a test
   *   injects the npm packages instead, which is the only way to run Prettier
   *   under Node — the bundle's web-tree-sitter path is browser-only.
   */
  constructor(loader) {
    this.#loader = loader || (() => /** @type {Promise<PrettierBundle>} */ (
      import(/* @vite-ignore */ VENDOR_URL)))
  }

  /** @returns {readonly string[]} */
  supportedLanguages() { return LANGUAGES }

  /** @param {string} language @returns {boolean} */
  supports(language) { return LANGUAGES.includes(language) }

  /**
   * @param {string} language @param {string} source
   * @returns {Promise<string>} the formatted source
   */
  async format(language, source) {
    const options = OPTIONS[language]
    if (!options) throw new Error(`PrettierFormatter: no options for language "${language}"`)
    const bundle = await this.#load()
    const run = (/** @type {object} */ opts) =>
      bundle.format(source, { ...COMMON, ...opts, plugins: bundle.plugins })
    if (language !== 'json') return run(options)
    try {
      return await run(options)
    } catch {
      // The first parser refused it; only the comment-tolerant one can say
      // whether this is commented JSON or simply broken, so ITS error is the
      // one the caller is told about.
      return await run(JSON_WITH_COMMENTS)
    }
  }

  /** @returns {Promise<PrettierBundle>} A failed load is not remembered: the
   *  next Format tries again rather than reporting a fetch that has since
   *  recovered. */
  #load() {
    if (!this.#bundle) {
      this.#bundle = this.#loader()
      this.#bundle.catch(() => { this.#bundle = null })
    }
    return this.#bundle
  }
}
