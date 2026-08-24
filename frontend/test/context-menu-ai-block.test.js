import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { serializeNode } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'

// context-menu.js:292 `yaml()` fed the ai-block Copy/Cut actions via a
// bus-published serializeAiBlockYaml — a symbol deleted in 45db37b (2026-06-04)
// while this consumer stayed, so Copy/Cut on an ai-block THREW at runtime
// (latent pre-existing defect). The fix rewires yaml() to the real
// serializeNode(editor, node) export. These tests pin the wiring:
//   non-empty payload → written to the clipboard, Cut deletes after the write;
//   EMPTY payload (structured sieve atoms currently serialize to '' — Go owns
//   their markdown) → warn + abort: NO clipboard write (Copy must not clear
//   the user's clipboard with '') and NO delete (Cut must not destroy the
//   block after copying nothing — silent data loss).
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', () => ({
  extractContentEntryFromEditor: vi.fn(),
  detectAndAppendExtractions: vi.fn(),
  serializeNode: vi.fn(),
}))

// context-menu.js imports applyTargetHighlight from lens/extensions.js, which
// (per ask-context.test.js's harness note) builds its Extension.create()/
// PluginKey members at MODULE-EVAL time off the tiptap-vendor `T` bag — those
// vendor members must exist on globalThis.TipTap BEFORE the module is first
// imported. Same permissive proxy stub, same members, same cleanup.
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
  'Highlight', 'markdownItMark',
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

const PAYLOAD = '```ai-block\nid: ai-1\nquestion: hi\n```'

describe('context-menu.js — ai-block Copy/Cut (serializeAiBlockYaml rewire)', () => {
  let prevClip, warnSpy, editor, node

  // Opens the ai-block context menu and returns the item whose label includes `label`.
  function openMenuItem(label) {
    document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
      detail: { x: 10, y: 10, context: { type: 'aiBlock', editor, node, getPos: () => 3 } },
    }))
    return Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
      .find((b) => b.textContent.includes(label))
  }

  beforeEach(() => {
    prevClip = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    node = { attrs: { id: 'ai-1', status: 'COMPLETE', question: 'hi' }, nodeSize: 1 }
    // del() reaches editor.state.tr.delete(...) then editor.view.dispatch(...) —
    // dispatch is the observable "the block was deleted" signal.
    editor = {
      state: { tr: { delete: vi.fn(() => 'del-tr') } },
      view: { dispatch: vi.fn() },
    }
    serializeNode.mockReset()
  })

  afterEach(() => {
    document.getElementById('sieve-context-menu')?.remove()
    warnSpy.mockRestore()
    if (prevClip !== undefined) {
      Object.defineProperty(navigator, 'clipboard', { value: prevClip, configurable: true })
    }
  })

  it('Copy with a non-empty payload writes it to the clipboard without throwing', () => {
    serializeNode.mockReturnValue(PAYLOAD)
    const copyBtn = openMenuItem('Copy')
    expect(copyBtn).toBeTruthy()

    expect(() => copyBtn.click()).not.toThrow()

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(PAYLOAD)
  })

  it('Cut with a non-empty payload writes it, then deletes the block', async () => {
    serializeNode.mockReturnValue(PAYLOAD)
    const cutBtn = openMenuItem('Cut')
    expect(cutBtn).toBeTruthy()

    cutBtn.click()
    await new Promise((r) => setTimeout(r, 0)) // let writeText's .then(del) run

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(PAYLOAD)
    expect(editor.view.dispatch).toHaveBeenCalledTimes(1)
  })

  it('Copy with an EMPTY payload warns and does NOT write the clipboard', () => {
    serializeNode.mockReturnValue('')
    const copyBtn = openMenuItem('Copy')
    expect(copyBtn).toBeTruthy()

    copyBtn.click()

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith('[sieve] ai-block serialize returned empty; copy aborted')
  })

  it('Cut with an EMPTY payload warns, does NOT write the clipboard, and does NOT delete the block', async () => {
    serializeNode.mockReturnValue('')
    const cutBtn = openMenuItem('Cut')
    expect(cutBtn).toBeTruthy()

    cutBtn.click()
    await new Promise((r) => setTimeout(r, 0)) // any stray .then(del) would run here

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(editor.view.dispatch).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith('[sieve] ai-block serialize returned empty; copy aborted')
  })
})
