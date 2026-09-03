// @ts-check
// lens-capabilities.test.js — the spec a lens publishes about itself (#118).
//
// A lens is constructed from two things and nothing else: WHICH CLASS the
// workspace built, and WHICH DEPENDENCIES it handed over. The spec is what falls
// out of those, computed once and frozen. These tests hold the three
// arrangements the app actually builds against the answer each must give, and
// pin the two properties that make the spec trustworthy — it cannot be
// renegotiated after construction, and an identity restriction beats whatever
// the container happens to offer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { ComposerEditor } from '../src/static/lens/composer/composer-editor.js'
import { NoteEditor } from '../src/static/lens/document-editor/note-editor.js'
import { PromptEditor } from '../src/static/lens/prompt/prompt-editor.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'
import { WysiwygSurface } from '../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'
import { InMemoryContainerProvider } from '../src/static/container/in-memory-container-provider.js'
import { LensCapability, LENS_CAPABILITIES } from '../src/static/contract/lens-capabilities.js'

// The four owner modules that run vendor calls at IMPORT time and would crash
// under the bare test/setup.js TipTap seed. Nothing here mounts a surface, so
// inert mocks satisfy the imports (the editor-toolbar.test.js pattern).
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn(), applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

/** @type {AbstractEditor[]} */ const built = []
afterEach(() => { while (built.length) /** @type {any} */ (built.pop()).destroy() })

/** @template {AbstractEditor} T @param {T} editor @returns {T} */
function track(editor) { built.push(editor); return editor }

/** The `@` picker's peer, as far as a lens can tell. */
const mentionService = { search: () => Promise.resolve([]) }

/** The `/` picker's peer, as far as a lens can tell. */
const commandService = { list: () => [] }

/** A block-capable container, as a document's provider is. */
function blockProvider() {
  return {
    getUuid: () => 'doc-1', getKind: () => 'note', getOrder: () => [], getBlock: () => null,
    subscribe: vi.fn(), unsubscribe: vi.fn(),
    requestAddBlock: vi.fn(), requestSetBlock: vi.fn(), requestRemoveBlock: vi.fn(),
    requestSetOrder: vi.fn(), requestTransform: vi.fn(), requestRetry: vi.fn(), requestPersist: vi.fn(),
    paste: vi.fn(), detectExtractions: vi.fn(), flush: vi.fn(),
    getContents: vi.fn(), setContents: vi.fn(), flushContents: vi.fn(),
  }
}

/** A whole-content-only container, as a prompt's provider is. */
function promptProvider() {
  return {
    getUuid: () => 'prompt:p', getKind: () => 'prompt', getOrder: () => [], getBlock: () => null,
    subscribe: vi.fn(), unsubscribe: vi.fn(),
    getContents: vi.fn(), setContents: vi.fn(), flushContents: vi.fn(),
  }
}

/** The composer arrangement the Ask panel builds. */
function composer(options = {}) {
  return track(new ComposerEditor('draft-1', Object.assign({
    provider: new InMemoryContainerProvider({ uuid: 'draft-1' }),
    mentionService,
    commandService,
  }, options)))
}

/** The note arrangement the workspace builds (Workspace#openDocument). */
function note(options = {}) {
  return track(new NoteEditor('doc-1', Object.assign({
    provider: blockProvider(),
    mentionService,
    macroCatalog: { list: () => [] },
    toolbar: null,
  }, options)))
}

describe('the arrangements the app builds', () => {
  it('a COMPOSER: everything but blocks — a draft mints none', () => {
    expect(composer().getCapabilities()).toEqual({
      markdown: true, mentions: true, commands: true, blocks: false,
    })
  })

  it('a NOTE editor: everything but commands — it is handed no command service', () => {
    expect(note().getCapabilities()).toEqual({
      markdown: true, mentions: true, commands: false, blocks: true,
    })
  })

  it('a PROMPT editor: markdown and mentions; its container has no block half', () => {
    const prompt = track(new PromptEditor('prompt:p', { provider: promptProvider(), mentionService }))
    expect(prompt.getCapabilities()).toEqual({
      markdown: true, mentions: true, commands: false, blocks: false,
    })
  })

  it('speaks the vocabulary and nothing else', () => {
    expect(Object.keys(composer().getCapabilities()).sort()).toEqual([...LENS_CAPABILITIES].sort())
  })
})

describe('a dependency is CONFIG, and the spec reflects it honestly', () => {
  it('reports `mentions: false` when it was given no mention service', () => {
    expect(composer({ mentionService: undefined }).getCapabilities()[LensCapability.MENTIONS]).toBe(false)
  })

  it('reports `commands: false` when it was given no command service', () => {
    expect(composer({ commandService: undefined }).getCapabilities()[LensCapability.COMMANDS]).toBe(false)
  })

  it('reads blocks off the container it was given — a note over a prompt container mints none', () => {
    expect(note({ provider: promptProvider() }).getCapabilities()[LensCapability.BLOCKS]).toBe(false)
  })
})

describe('an identity restriction is INNATE, and no container can grant it back', () => {
  it('a composer over a fully block-capable container still says `blocks: false`', () => {
    expect(composer({ provider: blockProvider() }).getCapabilities()[LensCapability.BLOCKS]).toBe(false)
  })

  it('so it creates no block when asked to', () => {
    const provider = blockProvider()
    composer({ provider }).createBlock('code', {})
    expect(provider.requestAddBlock).not.toHaveBeenCalled()
  })

  it('and it is mode-LOCKED: there is no second surface to flip to', async () => {
    expect(await composer().setMode(EditorMode.MARKDOWN)).toBe(false)
  })
})

describe('the spec is computed ONCE and cannot be renegotiated', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(composer().getCapabilities())).toBe(true)
  })

  it('is the SAME object every read — a consumer caching it cannot go stale', () => {
    const lens = composer()
    expect(lens.getCapabilities()).toBe(lens.getCapabilities())
  })

  it('does not change when the container grows a verb afterwards', () => {
    const provider = /** @type {any} */ (promptProvider())
    const lens = note({ provider })
    expect(lens.getCapabilities()[LensCapability.BLOCKS]).toBe(false)
    provider.requestAddBlock = vi.fn()
    expect(lens.getCapabilities()[LensCapability.BLOCKS]).toBe(false)
  })

  it('agrees with canEditBlocks, which is the same fact under an older name', () => {
    expect(composer().canEditBlocks).toBe(false)
    expect(note().canEditBlocks).toBe(true)
  })
})

describe('ComposerEditor — one surface, and the draft container it presents', () => {
  it('opens in WYSIWYG', () => {
    expect(composer().mode).toBe(EditorMode.WYSIWYG)
  })

  it('answers a WYSIWYG surface whatever mode is asked for', () => {
    const lens = /** @type {any} */ (composer())
    expect(lens._createSurface(EditorMode.WYSIWYG)).toBeInstanceOf(WysiwygSurface)
    expect(lens._createSurface(EditorMode.MARKDOWN)).toBeInstanceOf(WysiwygSurface)
  })

  it('takes its identity from its draft container', () => {
    expect(composer().provider.getKind()).toBe('draft')
  })
})
