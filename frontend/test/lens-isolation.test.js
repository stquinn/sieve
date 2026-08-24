// @ts-check
// lens-isolation.test.js — the firewall as a grep (issue #96 P3, widened to the
// whole merged lens/ package in P4c).
//
// A lens may reach `contract/` (the wall), `renderers/` (PM-free block
// look-and-feel), `ident/` (identity — a block born in a lens carries its real
// UUIDv7 from birth) and the two library leaves `vendor/`/`base/`, and nothing
// else — no host data plane, no shell, no generated protocol. That is what makes
// a lens hostable by something that is not this workspace, and it is checked
// TRANSITIVELY: a renderer that itself imports the model would smuggle the whole
// host in behind a legal-looking first hop.
//
// P4c moved `editor/` wholesale into `lens/`, so this now polices 40 files
// instead of the two pathfinders. The editor did NOT arrive clean, and the
// allowlist was deliberately NOT widened to hide that: the ten edges it still
// has into `shell/` and `ui/` are enumerated in QUARANTINE below and asserted
// EXACTLY. The list is a ratchet — a new coupling fails the suite, and a
// coupling that gets fixed fails it too, so the debt can only leave the tree
// deliberately. Do not add to it to make a change pass.
//
// Statement-form imports are the thing being policed. JSDoc `import('…')` type
// references live inside comments, which are stripped before matching — a type
// reference is not a module dependency, and the contract package's own purity
// test draws the same line.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// vitest's root is frontend/ (vitest.config.js), which process.cwd() matches at
// test time; happy-dom's global URL shadows node's, so resolving via
// import.meta.url is unreliable here.
const STATIC = path.resolve(process.cwd(), 'src/static')
const LENS_DIR = path.join(STATIC, 'lens')

// base/ is the X-C globals quarantine (icons + window bag) and is sanctioned
// here as debt; nothing in lens/ currently reaches it or vendor/.
const ALLOWED_DIRS = Object.freeze(['lens', 'contract', 'renderers', 'ident', 'vendor', 'base'])

// The couplings the P4b cutover did NOT dissolve. Each is a lens (or a renderer
// a lens paints through) calling host chrome directly instead of asking through
// the wall:
//
//   • ui/media-lightbox.js, ui/link-edit-dialog.js, ui/copy-image.js — host
//     chrome the block/prose paths summon inline (expand an image, edit a link,
//     copy an image). A lens should raise these, not open them.
//   • shell/trigger-*.js — the WysiwygSurface builds the shell's `@`-mention
//     popover itself rather than exposing its CaretTriggerPort and letting the
//     host attach one.
//   • renderers/asset-urls.js → generated/protocol.js — the one non-lens entry:
//     a renderer resolves asset URLs through the generated wire module, so the
//     whole renderer package (and therefore any lens that paints with it) drags
//     the protocol in.
const QUARANTINE = Object.freeze([
  'lens/document-editor/interaction-policy.js → ../../ui/media-lightbox.js',
  'lens/document-editor/surfaces/node-views/smart-card-node-view.js → ../../../../ui/link-edit-dialog.js',
  'lens/document-editor/surfaces/prose-link.js → ../../../ui/link-edit-dialog.js',
  'lens/document-editor/surfaces/sieve-block-extension.js → ../../../ui/media-lightbox.js',
  'lens/document-editor/surfaces/wysiwyg-surface.js → ../../../shell/trigger-host.js',
  'lens/document-editor/surfaces/wysiwyg-surface.js → ../../../shell/trigger-popover.js',
  'lens/document-editor/surfaces/wysiwyg-surface.js → ../../../shell/trigger-providers.js',
  'lens/document-editor/surfaces/wysiwyg-surface.js → ../../../ui/copy-image.js',
  'renderers/asset-urls.js → ../generated/protocol.js',
  'renderers/diagram-renderer.js → ../ui/media-lightbox.js',
])

// The modules those edges drag in, transitively — the closure's forbidden half.
const QUARANTINED_MODULES = Object.freeze([
  'generated/protocol.js',
  'shell/trigger-host.js',
  'shell/trigger-popover.js',
  'shell/trigger-providers.js',
  'ui/copy-image.js',
  'ui/link-edit-dialog.js',
  'ui/media-lightbox.js',
])

/** Walks statement-form imports from a set of entry files. */
class ImportGraph {
  /** @type {string[]} */ #roots

  /** @param {string[]} allowedDirs absolute directories a reached file may live in;
   *   empty means "follow everything", which is how the walker itself is tested */
  constructor(allowedDirs) { this.#roots = allowedDirs }

  /** Every .js file under a directory, recursively.
   *  @param {string} dir @returns {string[]} */
  static sources(dir) {
    /** @type {string[]} */
    const found = []
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) found.push(...ImportGraph.sources(full))
      else if (entry.endsWith('.js')) found.push(full)
    }
    return found
  }

  /**
   * @param {string[]} entries
   * @returns {{reached: string[], violations: string[], bare: string[]}}
   *   reached — every file the walk visited, entries included
   *   violations — `file → specifier` pairs resolving outside the allowed dirs
   *   bare — non-relative specifiers (an npm package or a bare global)
   */
  walk(entries) {
    /** @type {Set<string>} */ const reached = new Set()
    /** @type {string[]} */ const violations = []
    /** @type {string[]} */ const bare = []
    const queue = [...entries]

    while (queue.length) {
      const file = /** @type {string} */ (queue.shift())
      if (reached.has(file)) continue
      reached.add(file)
      expect(existsSync(file), `${file} does not exist`).toBe(true)

      for (const specifier of this.#specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) { bare.push(`${this.#rel(file)} → ${specifier}`); continue }
        const resolved = path.resolve(path.dirname(file), specifier)
        if (this.#allowed(resolved)) queue.push(resolved)
        else violations.push(`${this.#rel(file)} → ${specifier}`)
      }
    }
    return { reached: [...reached].map((f) => this.#rel(f)).sort(), violations: violations.sort(), bare }
  }

  /** @param {string} file @returns {boolean} */
  #allowed(file) {
    if (!this.#roots.length) return true
    return this.#roots.some((root) => file === root || file.startsWith(root + path.sep))
  }

  /** @param {string} file @returns {string} */
  #rel(file) { return path.relative(STATIC, file) }

  /**
   * Import specifiers in one source, comments removed first: JSDoc type
   * references (`import('./x.js').Y`) live in block comments and are not
   * dependencies. Only whole-line `//` comments are stripped — a trailing one
   * would have to contain a literal `from '…'` to matter.
   *
   * The specifier must END its line (bar a semicolon), which is true of every
   * import statement and false of the `'… from ' + domain` string concatenations
   * the web-clip renderer builds its labels from.
   * @param {string} source @returns {string[]}
   */
  #specifiersOf(source) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    /** @type {string[]} */
    const specifiers = []
    for (const m of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]\s*;?\s*$/gm)) specifiers.push(m[1])
    for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]\s*;?\s*$/gm)) specifiers.push(m[1])
    return specifiers
  }
}

const lensFiles = ImportGraph.sources(LENS_DIR)
const graph = new ImportGraph(ALLOWED_DIRS.map((dir) => path.join(STATIC, dir)))
const result = graph.walk(lensFiles)

describe('lens/ is reachable-from nothing but contract/, renderers/ and the library leaves', () => {
  it('found the files it means to police', () => {
    // A directory-read bug must not pass this suite by vacuously finding
    // nothing to walk, and a file quietly leaving lens/ must be a deliberate
    // edit here rather than a silently smaller check.
    expect(lensFiles.map((f) => path.relative(STATIC, f))).toEqual([
      path.join('lens', 'abstract-editor.js'),
      path.join('lens', 'document-editor', 'block-chrome.js'),
      path.join('lens', 'document-editor', 'block-selection.js'),
      path.join('lens', 'document-editor', 'block-sync.js'),
      path.join('lens', 'document-editor', 'context-menu.js'),
      path.join('lens', 'document-editor', 'editor-mode.js'),
      path.join('lens', 'document-editor', 'editor-shell.js'),
      path.join('lens', 'document-editor', 'editor-toolbar.js'),
      path.join('lens', 'document-editor', 'interaction-policy.js'),
      path.join('lens', 'document-editor', 'note-editor.js'),
      path.join('lens', 'document-editor', 'paste-context.js'),
      path.join('lens', 'document-editor', 'selection-model.js'),
      path.join('lens', 'document-editor', 'surfaces', 'abstract-surface.js'),
      path.join('lens', 'document-editor', 'surfaces', 'ai-target-decoration.js'),
      path.join('lens', 'document-editor', 'surfaces', 'ai-target.js'),
      path.join('lens', 'document-editor', 'surfaces', 'block-position.js'),
      path.join('lens', 'document-editor', 'surfaces', 'block-render.js'),
      path.join('lens', 'document-editor', 'surfaces', 'caret-trigger-port.js'),
      path.join('lens', 'document-editor', 'surfaces', 'markdown-surface.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'ai-block-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'attachment-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'code-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'diagram-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'log-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'smart-card-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'smart-image-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'node-views', 'web-clip-node-view.js'),
      path.join('lens', 'document-editor', 'surfaces', 'prose-block.js'),
      path.join('lens', 'document-editor', 'surfaces', 'prose-group.js'),
      path.join('lens', 'document-editor', 'surfaces', 'prose-link.js'),
      path.join('lens', 'document-editor', 'surfaces', 'prose-markers.js'),
      path.join('lens', 'document-editor', 'surfaces', 'render-empty.js'),
      path.join('lens', 'document-editor', 'surfaces', 'sieve-block-extension.js'),
      path.join('lens', 'document-editor', 'surfaces', 'tiptap-vendor.js'),
      path.join('lens', 'document-editor', 'surfaces', 'wysiwyg-surface.js'),
      path.join('lens', 'document-editor', 'toolbar-button.js'),
      path.join('lens', 'extensions.js'),
      path.join('lens', 'lens.js'),
      path.join('lens', 'outline', 'outline-lens.js'),
      path.join('lens', 'prompt', 'prompt-editor.js'),
    ])
  })

  it('imports nothing outside the allowlist but the frozen quarantine', () => {
    expect(result.violations).toEqual([...QUARANTINE])
  })

  it('imports no package and no global bundle', () => {
    expect(result.bare).toEqual([])
  })

  it('reaches no host, shell, generated or ui module but the quarantined ones', () => {
    // The allowlist walk above STOPS at a violation, so this one follows every
    // edge instead and names what the closure actually contains — the case it
    // catches that the allowlist alone would only report as a violating pair is
    // an allowed renderer that grows a forbidden import of its own.
    const reachable = new ImportGraph([]).walk(lensFiles).reached
    const forbidden = reachable.filter((file) => {
      const pkg = file.split(path.sep)[0]
      return pkg === 'container' || pkg === 'shell' || pkg === 'generated' || pkg === 'ui' || pkg === 'ai'
    })
    expect(forbidden).toEqual([...QUARANTINED_MODULES])
    // container/ — the host data plane — is the one the cutover DID finish:
    // no lens reaches it by any path, and none ever may.
    expect(forbidden.filter((f) => f.startsWith('container' + path.sep))).toEqual([])
  })

  it('walks transitively, not one hop deep', () => {
    // Proven against a chain that really is deep: BlockRenderer → its markdown
    // engine → the asset-url helper → the generated protocol module. P4c moved
    // the SieveBlock data shape into contract/, so the base class is no longer
    // host-coupled through IT — this asset-url chain is the last thing keeping a
    // lens from extending BlockRenderer, and it is the quarantine's tenth entry.
    const open = new ImportGraph([])
    const reached = open.walk([path.join(STATIC, 'renderers', 'block-renderer.js')]).reached
    expect(reached).toContain(path.join('contract', 'sieve-block.js'))
    expect(reached).toContain(path.join('generated', 'protocol.js'))
  })
})
