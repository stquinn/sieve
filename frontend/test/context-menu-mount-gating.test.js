// @ts-check
// context-menu-mount-gating.test.js — the editor context menu is DERIVED FROM
// THE MOUNT (#118 2e).
//
// Two rules, and only two. DATA verbs gate on PROVIDER SHAPE: a container with
// no `detectExtractions` offers no Extract / Transform / Embed-in-Document, and
// the gate is the one `typeof` already inside detectAndAppendExtractions. HOST
// verbs gate on the lens's published capabilities: a verb that MAKES a block is
// not offered where none can be made — which is what "no Ask inside an Ask"
// means mechanically.
//
// And the insert entries come from the host's own catalog, so the menu and the
// `{` picker cannot offer different things in the same mount.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { detectAndAppendExtractions } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'
import { BlockMacro, ActionMacro } from '../src/static/shell/trigger-providers.js'
import { LensCapability } from '../src/static/contract/lens-capabilities.js'

vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', () => ({
  NodeViewRegistry: { extractContentEntryFromEditor: vi.fn(() => null) },
  detectAndAppendExtractions: vi.fn(),
  serializeNode: vi.fn(() => ''),
}))
vi.mock('../src/static/lens/document-editor/surfaces/prose-link.js', () => ({
  ProseLink: { forSelection: vi.fn(() => null) },
}))

// context-menu.js reaches lens/extensions.js, which builds its Extension.create()
// / PluginKey members at MODULE-EVAL time off the tiptap-vendor bag.
function makeProxy() {
  const fn = function () { return makeProxy() }
  fn.create = () => makeProxy()
  fn.extend = () => makeProxy()
  return new Proxy(fn, {
    apply() { return makeProxy() },
    construct() { return makeProxy() },
    get(t, prop) {
      if (prop in t) return t[prop]
      const child = makeProxy()
      t[prop] = child
      return child
    },
  })
}
const STUBBED_VENDOR_MEMBERS = [
  'Node', 'Extension', 'Plugin', 'PluginKey', 'Decoration', 'DecorationSet',
  'Highlight', 'markdownItMark', 'StarterKit', 'Placeholder', 'Table', 'TableRow',
  'TableHeader', 'TableCell', 'Image', 'TaskList', 'TaskItem', 'Markdown', 'Editor',
]

beforeAll(async () => {
  const stubs = {}
  for (const name of STUBBED_VENDOR_MEMBERS) stubs[name] = makeProxy()
  Object.assign(globalThis.TipTap, stubs)
  await import('../src/static/lens/document-editor/context-menu.js')
})

afterAll(() => {
  for (const name of STUBBED_VENDOR_MEMBERS) delete globalThis.TipTap[name]
})

/** What a NOTE mount publishes. */
const NOTE_CAPS = Object.freeze({ markdown: true, mentions: true, commands: false, blocks: true })
/** What a COMPOSER mount publishes: a draft mints no blocks. */
const DRAFT_CAPS = Object.freeze({ markdown: true, mentions: true, commands: true, blocks: false })

/** A catalog with one entry of each half of the #91 split. */
function catalogOf() {
  return {
    list: () => [
      new BlockMacro({ kind: 'code', label: 'Code Block', description: 'source' }),
      new ActionMacro({
        label: 'Web Clip', name: 'web-clip', requires: LensCapability.BLOCKS, action: vi.fn(),
      }),
    ],
  }
}

/**
 * A live pane as the menu reads one, stamped with the lens that mounted it. The
 * doc is a single empty paragraph: nothing here is about what was clicked.
 * @param {any} lens @param {{selection?: any}} [opts]
 */
function paneFor(lens, opts = {}) {
  const doc = {
    content: { size: 4 },
    nodesBetween: () => {},
    resolve: () => ({ depth: 0 }),
  }
  return {
    sieveHost: lens,
    state: { doc, selection: opts.selection || { from: 1, to: 1, empty: true } },
    view: { posAtCoords: () => null },
    isActive: () => false,
    commands: { focus: vi.fn(), selectAll: vi.fn(), setTextSelection: vi.fn() },
  }
}

/** The lens whose mount the menu is derived from. `draftVerbs` adds what only a
 *  DRAFT's lens answers to — the two asks its menu makes of whoever keeps the
 *  message. `marked` is the title of the token under the caret, if any. */
function lensWith(caps, { catalog = catalogOf(), draftVerbs = false, marked = null } = {}) {
  const lens = {
    canEditBlocks: caps[LensCapability.BLOCKS],
    getCapabilities: () => caps,
    macroCatalog: catalog,
    createBlock: vi.fn(),
    pasteText: vi.fn(),
    mentionTitleAt: () => marked,
  }
  if (draftVerbs) {
    Object.assign(lens, { requestDetach: vi.fn(), requestClear: vi.fn() })
  }
  return lens
}

/** Opens the editor context menu over `pane` and returns its item labels. */
function menuLabels(pane) {
  document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
    detail: { x: 10, y: 10, context: { type: 'editor', editor: pane } },
  }))
  return Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
    .map((b) => b.textContent)
}

beforeEach(() => { vi.mocked(detectAndAppendExtractions).mockClear() })
afterEach(() => { document.getElementById('sieve-context-menu')?.remove() })

describe('host verbs come from the mount', () => {
  it('a NOTE mount offers Ask AI and Explain', () => {
    const labels = menuLabels(paneFor(lensWith(NOTE_CAPS)))
    expect(labels).toContain('Ask AI...')
    expect(labels).toContain('Explain')
  })

  it('a DRAFT mount offers NEITHER — there is no Ask inside an Ask', () => {
    const labels = menuLabels(paneFor(lensWith(DRAFT_CAPS)))
    expect(labels).not.toContain('Ask AI...')
    expect(labels).not.toContain('Explain')
  })

  it('the editing verbs survive the gate — a draft is still text you edit', () => {
    const labels = menuLabels(paneFor(lensWith(DRAFT_CAPS)))
    expect(labels).toContain('Paste')
    expect(labels).toContain('Select All')
  })
})

describe('insert entries read the host catalog, so the menu and the `{` picker agree', () => {
  it('a NOTE mount offers what its catalog offers', () => {
    const labels = menuLabels(paneFor(lensWith(NOTE_CAPS)))
    expect(labels).toContain('Insert Code Block')
    expect(labels).toContain('Insert Web Clip')
  })

  it('a DRAFT mount keeps the flow entries and loses every minting one', () => {
    const labels = menuLabels(paneFor(lensWith(DRAFT_CAPS)))
    // The surface's own PM-native presets require only `markdown`, so a draft
    // still gets them: a question may well contain a table.
    expect(labels.filter((l) => l.startsWith('Insert ')))
      .toEqual(['Insert Table', 'Insert Quote', 'Insert Divider', 'Insert Fence'])
  })

  it('picking one runs the entry against the lens that published the catalog', () => {
    const lens = lensWith(NOTE_CAPS)
    menuLabels(paneFor(lens))
    const insert = Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
      .find((b) => b.textContent === 'Insert Code Block')
    const button = /** @type {HTMLElement} */ (insert)
    button.click()
    expect(lens.createBlock).toHaveBeenCalledWith('code', {})
  })

  it('a mount with NO catalog still offers its surface presets', () => {
    const labels = menuLabels(paneFor(lensWith(NOTE_CAPS, { catalog: null })))
    expect(labels.filter((l) => l.startsWith('Insert ')))
      .toEqual(['Insert Table', 'Insert Quote', 'Insert Divider', 'Insert Fence'])
    expect(labels).toContain('Paste')
  })
})

// `==` is the ask TARGET mark: it names a coordinate a question is answered
// about. A draft mints no block for one to be the target of, so the verb is not
// offered there — the same reading that removes Ask AI.
describe('the highlight verb is a note verb', () => {
  const SELECTED = { selection: { from: 1, to: 4, empty: false } }

  it('a NOTE mount offers it over a selection', () => {
    expect(menuLabels(paneFor(lensWith(NOTE_CAPS), SELECTED))).toContain('Highlight Target')
  })

  it('a DRAFT mount does not, selection or no selection', () => {
    expect(menuLabels(paneFor(lensWith(DRAFT_CAPS), SELECTED))).not.toContain('Highlight Target')
    expect(menuLabels(paneFor(lensWith(DRAFT_CAPS)))).not.toContain('Highlight Target')
  })
})

// A chip and its `@Title` token are ONE object, so the token's menu detaches
// too. What is offered follows the MARK under the caret, which is drawn from the
// manifest — so a mount that keeps none marks nothing and is offered nothing.
describe('Remove Attachment follows the marked token', () => {
  it('is offered where the caret is in one, and asks the lens by name', () => {
    const lens = lensWith(DRAFT_CAPS, { draftVerbs: true, marked: 'Auth Design' })
    const labels = menuLabels(paneFor(lens))
    expect(labels).toContain('Remove Attachment')
    const item = Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
      .find((b) => b.textContent === 'Remove Attachment')
    const button = /** @type {HTMLElement} */ (item)
    button.click()
    expect(lens.requestDetach).toHaveBeenCalledWith('Auth Design')
  })

  it('is absent where no token is marked', () => {
    const labels = menuLabels(paneFor(lensWith(DRAFT_CAPS, { draftVerbs: true })))
    expect(labels).not.toContain('Remove Attachment')
  })

  it('is absent in a note, which marks nothing however the caret sits', () => {
    const labels = menuLabels(paneFor(lensWith(NOTE_CAPS, { marked: 'Auth Design' })))
    expect(labels).not.toContain('Remove Attachment')
  })
})

describe('Clear Draft belongs to a mount that can be retired', () => {
  it('a DRAFT mount offers it, and it asks the lens', () => {
    const lens = lensWith(DRAFT_CAPS, { draftVerbs: true })
    expect(menuLabels(paneFor(lens))).toContain('Clear Draft')
    const item = Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
      .find((b) => b.textContent === 'Clear Draft')
    const button = /** @type {HTMLElement} */ (item)
    button.click()
    expect(lens.requestClear).toHaveBeenCalled()
  })

  it('a NOTE mount does not — a document is not a message being written', () => {
    expect(menuLabels(paneFor(lensWith(NOTE_CAPS)))).not.toContain('Clear Draft')
  })
})

// The extraction path is gated ONCE, inside detectAndAppendExtractions, on the
// presence of the provider's `detectExtractions`. The menu's part is only to
// describe the source and ask; when there is nothing to describe it never asks.
describe('data verbs gate on provider shape', () => {
  it('the menu asks nothing of a caret with no convertible source under it', () => {
    menuLabels(paneFor(lensWith(NOTE_CAPS)))
    expect(detectAndAppendExtractions).not.toHaveBeenCalled()
  })
})

// Markdown mode has no ProseMirror pane — `editorPane` is null there — so a
// right-click over it dispatches `{ type: 'editor', editor: null }`. The menu
// must answer with nothing rather than throw reading `editor.state`.
describe('a null editor (markdown mode) yields no editor items', () => {
  it('does not throw, and opens with no items', () => {
    expect(() => {
      document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
        detail: { x: 10, y: 10, context: { type: 'editor', editor: null } },
      }))
    }).not.toThrow()
    expect(document.querySelectorAll('#sieve-context-menu .ctx-item').length).toBe(0)
  })
})
