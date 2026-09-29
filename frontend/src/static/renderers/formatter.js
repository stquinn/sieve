// @ts-check
// What it means to be able to pretty-print source.
//
// A formatter COMPUTES A STRING. It reads a language and some source and answers
// with the formatted source; it does not know what holds that source, and it
// never writes anything. Whoever asked owns the write.
//
// `supports` and `supportedLanguages` are SYNCHRONOUS, because a menu decides
// whether to offer Format while it is being built. `format` is a Promise: a
// formatter may have a bundle to load before it can answer.
//
// The language is the canonical name (`javascript`, not `js`). Canonicalising is
// CodeFormattingService's job, so a formatter behind it answers about one name
// per language.

/**
 * @typedef {object} Formatter
 * @property {(language: string, source: string) => Promise<string>} format
 *   the formatted source. Rejects when the source does not parse, or when the
 *   language is not one this formatter supports.
 * @property {(language: string) => boolean} supports
 *   whether `format` would attempt this language.
 * @property {() => readonly string[]} supportedLanguages
 *   every language `supports` answers true for.
 */

export {}
