// @ts-check
// contract-purity.test.js — permanent tripwire for contract/'s ONE structural
// rule (issue #96 P2): it is a LEAF package. Every side of the Lens↔Host wall
// depends on these shapes, so nothing here may depend on anything outside
// this directory — not the concrete model, not a lens, not the host.
//
// Statement-form `import ... from '...'` lines are the thing being policed.
// A JSDoc type-only reference (`@property {import('./x.js').Y} …`) is
// deliberately NOT an import statement — it never terminates the line right
// after the string literal — so the regex below does not flag it.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// happy-dom's global `URL` shadows node's during the test run, so resolving
// this directory via `new URL(..., import.meta.url)` is unreliable here;
// vitest's root is the `frontend/` package root (vitest.config.js), which
// `process.cwd()` matches at test time.
const CONTRACT_DIR = path.resolve(process.cwd(), 'src/static/contract')
const IMPORT_STATEMENT = /^\s*import\s+(?:[\w*\s,{}]+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/gm

const jsFiles = readdirSync(CONTRACT_DIR).filter((f) => f.endsWith('.js')).sort()

describe('contract/ is a leaf package', () => {
  it('found the files it means to police', () => {
    // A directory-read bug (wrong path, empty dir) must not pass the suite by
    // vacuously finding nothing to assert against.
    expect(jsFiles).toEqual([
      'container-provider.js',
      'container-update-listener.js',
      'lens-capabilities.js',
      'selection-listener.js',
      'sieve-block.js',
    ])
  })

  for (const file of jsFiles) {
    it(`${file} imports nothing outside contract/`, () => {
      const source = readFileSync(path.join(CONTRACT_DIR, file), 'utf8')
      const specifiers = [...source.matchAll(IMPORT_STATEMENT)].map((m) => m[1])
      expect(specifiers).toEqual([])
    })
  }

  it('every contract module loads as an ES module', async () => {
    const containerProvider = await import('../src/static/contract/container-provider.js')
    const containerUpdateListener = await import('../src/static/contract/container-update-listener.js')
    const lensCapabilities = await import('../src/static/contract/lens-capabilities.js')
    const selectionListener = await import('../src/static/contract/selection-listener.js')
    const sieveBlock = await import('../src/static/contract/sieve-block.js')
    expect(containerProvider).toBeTypeOf('object')
    expect(containerUpdateListener).toBeTypeOf('object')
    expect(lensCapabilities.LensCapability.BLOCKS).toBe('blocks')
    expect(selectionListener).toBeTypeOf('object')
    expect(sieveBlock.SieveBlock).toBeTypeOf('function')
  })
})
