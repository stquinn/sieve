// @ts-check
// The formatting side of Format: CodeFormattingService's composition rule, and
// PrettierFormatter's loading and options.
//
// A FORMATTER COMPUTES A STRING AND NOTHING ELSE, so both halves are tested with
// no document, no pane and no DOM. Who writes the string is code-format-action's
// business and is tested there.
//
// THE REAL-PRETTIER GUARD AT THE BOTTOM runs the npm packages, not the vendored
// bundle: `vendor/prettier.js` is built for the browser and its web-tree-sitter
// path does not run under Node. That is exactly what PrettierFormatter's injected
// loader is for.
import { describe, it, expect, vi } from 'vitest'
import { CodeFormattingService, UnsupportedLanguageError } from '../src/static/renderers/code-formatting-service.js'
import { PrettierFormatter } from '../src/static/renderers/prettier-formatter.js'

/** A formatter double: it claims some languages and answers with a tag, so which
 *  one answered is visible in the result.
 *  @param {string} tag @param {string[]} languages */
function formatterDouble(tag, languages) {
  return {
    tag,
    calls: /** @type {string[][]} */ ([]),
    supportedLanguages() { return languages },
    supports(/** @type {string} */ l) { return languages.includes(l) },
    format(/** @type {string} */ l, /** @type {string} */ s) {
      this.calls.push([l, s])
      return Promise.resolve(`${tag}:${l}:${s}`)
    },
  }
}

describe('CodeFormattingService — which formatter answers', () => {
  it('asks the FIRST formatter that supports the language, and no later one', async () => {
    const first = formatterDouble('first', ['json', 'yaml'])
    const second = formatterDouble('second', ['json', 'go'])
    const svc = new CodeFormattingService([first, second])
    expect(await svc.format('json', 'x')).toBe('first:json:x')
    expect(second.calls).toEqual([])
    // ...and the one only the second offers still reaches it.
    expect(await svc.format('go', 'x')).toBe('second:go:x')
  })

  it('rejects an unformattable language with a NAMED error, asking nobody', async () => {
    const only = formatterDouble('only', ['json'])
    const svc = new CodeFormattingService([only])
    await expect(svc.format('cobol', 'x')).rejects.toBeInstanceOf(UnsupportedLanguageError)
    expect(only.calls).toEqual([])
    expect(svc.supports('cobol')).toBe(false)
  })

  it('reports the UNION of its formatters languages, each once', () => {
    const svc = new CodeFormattingService([
      formatterDouble('a', ['json', 'yaml']),
      formatterDouble('b', ['yaml', 'go']),
    ])
    expect(Array.from(svc.supportedLanguages()).sort()).toEqual(['go', 'json', 'yaml'])
  })

  it('offers nothing when it holds no formatters', () => {
    const svc = new CodeFormattingService([])
    expect(svc.supports('json')).toBe(false)
    expect(svc.supportedLanguages()).toEqual([])
  })

  // A fence carries whatever its author typed after the backticks, so the alias
  // is resolved HERE and nothing below the service ever sees one.
  it('canonicalises the language before asking, and passes the canonical name down', async () => {
    const js = formatterDouble('p', ['javascript', 'yaml'])
    const svc = new CodeFormattingService([js])
    expect(svc.supports('js')).toBe(true)
    expect(svc.supports('yml')).toBe(true)
    expect(svc.supports('JS')).toBe(true)
    expect(await svc.format('js', 'x')).toBe('p:javascript:x')
    expect(js.calls).toEqual([['javascript', 'x']])
  })

  it('treats an absent language as no language at all', () => {
    const svc = new CodeFormattingService([formatterDouble('p', ['javascript'])])
    expect(svc.supports('')).toBe(false)
    expect(svc.supports(/** @type {any} */ (null))).toBe(false)
  })
})

/** A Prettier bundle double recording every call. */
function bundleDouble(result = 'formatted') {
  return {
    calls: /** @type {any[][]} */ ([]),
    plugins: ['PLUGINS'],
    format(/** @type {string} */ s, /** @type {any} */ o) {
      this.calls.push([s, o])
      return Promise.resolve(result)
    },
  }
}

describe('PrettierFormatter — the bundle and the options', () => {
  it('claims exactly the four languages in scope', () => {
    const f = new PrettierFormatter(() => Promise.resolve(bundleDouble()))
    expect(Array.from(f.supportedLanguages()).sort()).toEqual(['java', 'javascript', 'json', 'yaml'])
    expect(f.supports('java')).toBe(true)
    expect(f.supports('go')).toBe(false)
  })

  it('loads the bundle ONCE across calls', async () => {
    const bundle = bundleDouble()
    const loader = vi.fn(() => Promise.resolve(bundle))
    const f = new PrettierFormatter(loader)
    await f.format('yaml', 'a: 1')
    await f.format('java', 'class A {}')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  // A fetch that failed once has no business breaking Format for the session.
  it('does not remember a FAILED load: the next format tries again', async () => {
    const bundle = bundleDouble()
    let attempt = 0
    const loader = vi.fn(() => ++attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(bundle))
    const f = new PrettierFormatter(loader)
    await expect(f.format('yaml', 'a: 1')).rejects.toThrow('offline')
    expect(await f.format('yaml', 'a: 1')).toBe('formatted')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('passes the per-language parser and width, plus the shared house style', async () => {
    const bundle = bundleDouble()
    const f = new PrettierFormatter(() => Promise.resolve(bundle))
    for (const language of ['yaml', 'javascript', 'java']) await f.format(language, 'src')
    const opts = bundle.calls.map(([, o]) => o)
    expect(opts.map((o) => [o.parser, o.tabWidth])).toEqual([
      ['yaml', 2], ['babel', 2], ['java', 4],
    ])
    for (const o of opts) {
      expect(o).toMatchObject({ printWidth: 100, useTabs: false, endOfLine: 'lf' })
      expect(o.plugins).toEqual(['PLUGINS'])
    }
  })

  it('refuses a language it has no options for without loading anything', async () => {
    const loader = vi.fn(() => Promise.resolve(bundleDouble()))
    const f = new PrettierFormatter(loader)
    await expect(f.format('go', 'x')).rejects.toThrow(/no options/)
    expect(loader).not.toHaveBeenCalled()
  })

  // json-stringify expands like an IDE and keeps numbers verbatim but refuses
  // comments; `json` is the only parser that reads a commented file.
  it('retries JSON with the comment-tolerant parser when json-stringify refuses', async () => {
    /** @type {any[]} */ const seen = []
    const bundle = {
      plugins: [],
      format(/** @type {string} */ _s, /** @type {any} */ o) {
        seen.push(o.parser)
        if (o.parser === 'json-stringify') return Promise.reject(new Error('comments'))
        return Promise.resolve('{ "a": 1 }')
      },
    }
    const f = new PrettierFormatter(() => Promise.resolve(bundle))
    expect(await f.format('json', '// c\n{"a":1}')).toBe('{ "a": 1 }')
    expect(seen).toEqual(['json-stringify', 'json'])
  })

  it('reports the FALLBACK parser error when neither parser can read the JSON', async () => {
    const bundle = {
      plugins: [],
      format(/** @type {string} */ _s, /** @type {any} */ o) {
        return Promise.reject(new Error(o.parser === 'json' ? 'unexpected token' : 'stringify said no'))
      },
    }
    const f = new PrettierFormatter(() => Promise.resolve(bundle))
    await expect(f.format('json', '{bad')).rejects.toThrow('unexpected token')
  })
})

// ---------------------------------------------------------------------------
// The guard over the real thing. It pins what an upgrade of Prettier or of
// prettier-plugin-java is allowed to change about the output we ship: comments
// survive, a second format is a no-op, numbers are not rewritten, and invalid
// input is refused rather than mangled.
// ---------------------------------------------------------------------------

/** The npm packages, assembled exactly as prettier-bundle-entry.js assembles the
 *  browser bundle. Loaded once for the whole describe. */
async function npmBundle() {
  const [standalone, babel, estree, yaml, java] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/yaml'),
    import('prettier-plugin-java'),
  ])
  return { format: standalone.format, plugins: [babel, estree, yaml, java.default || java] }
}

describe('PrettierFormatter over real Prettier', () => {
  const formatter = new PrettierFormatter(npmBundle)

  /** @type {{language: string, source: string, keeps: string[]}[]} */
  const CASES = [
    { language: 'json', source: '{"a":1,"b":[1,2]}', keeps: [] },
    { language: 'yaml', source: '# leading\nroot:\n  a: 1   # trailing\n', keeps: ['# leading', '# trailing'] },
    { language: 'javascript', source: '// note\nconst a  =  {b:1,c:[1,2]}\n', keeps: ['// note'] },
    { language: 'java', source: '// note\nclass A { int f() { return 1; } }', keeps: ['// note'] },
  ]

  for (const { language, source, keeps } of CASES) {
    it(`${language}: keeps its comments and formats idempotently`, async () => {
      const once = await formatter.format(language, source)
      expect(once).not.toBe('')
      for (const comment of keeps) expect(once).toContain(comment)
      expect(await formatter.format(language, once)).toBe(once)
    }, 20000)
  }

  it('json: reads a COMMENTED file through the fallback parser', async () => {
    const out = await formatter.format('json', '{\n  // which one\n  "a": 1\n}')
    expect(out).toContain('// which one')
    expect(out).toContain('"a": 1')
  })

  // json-stringify is chosen for exactly this: an IDE expands every member and
  // reproduces the number the author wrote.
  it('json: expands every member and leaves numbers exactly as written', async () => {
    const out = await formatter.format('json', '{"a":1.50,"b":{"c":2}}')
    expect(out).toContain('1.50')
    expect(out.split('\n').length).toBeGreaterThan(4)
  })

  it('java: indents by four, and formats a bare fragment', async () => {
    const klass = await formatter.format('java', 'class A { int f() { return 1; } }')
    expect(klass).toMatch(/\n {4}int f\(\)/)
    // tree-sitter is error-tolerant, so a method with no class around it formats.
    const fragment = await formatter.format('java', 'int f( ) {return 1;}')
    expect(fragment).toContain('return 1;')
  }, 20000)

  it('refuses source that does not parse, and says so', async () => {
    await expect(formatter.format('json', '{bad')).rejects.toThrow()
    await expect(formatter.format('javascript', 'const = ')).rejects.toThrow()
  })
})
