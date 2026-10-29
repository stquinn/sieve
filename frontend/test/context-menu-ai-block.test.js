import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

// H9: the ai-block node menu's Copy / Cut are Mod+C / Mod+X over the block's
// NodeSelection, so they write exactly the clipboard the keyboard does.
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', () => ({
  extractContentEntryFromEditor: vi.fn(),
  detectAndAppendExtractions: vi.fn(),
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

describe('context-menu.js — ai-block Copy / Cut (H9)', () => {
  let editor, node, execCommand, selected

  function openMenuItem(label) {
    document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
      detail: { x: 10, y: 10, context: { type: 'aiBlock', editor, node, getPos: () => 3 } },
    }))
    return Array.from(document.querySelectorAll('#sieve-context-menu .ctx-item'))
      .find((b) => b.textContent.includes(label))
  }

  beforeEach(() => {
    node = { attrs: { id: 'ai-1', status: 'COMPLETE', question: 'hi' }, nodeSize: 1 }
    selected = []
    const chain = {
      focus: () => chain,
      setNodeSelection: (pos) => { selected.push(pos); return chain },
      run: () => true,
    }
    editor = {
      chain: () => chain,
      commands: { focus: vi.fn() },
      state: { tr: { delete: vi.fn(() => 'del-tr') } },
      view: { dispatch: vi.fn() },
    }
    execCommand = vi.fn(() => true)
    document.execCommand = execCommand
  })

  afterEach(() => {
    document.getElementById('sieve-context-menu')?.remove()
    delete document.execCommand
  })

  it.each([['Copy', 'copy'], ['Cut', 'cut']])('%s selects the block, then runs the keyboard\'s %s', (label, command) => {
    openMenuItem(label).click()
    expect(selected).toEqual([3])
    expect(execCommand.mock.calls).toEqual([[command]])
    // A cut's delete is the policy's, through the event: the menu deletes nothing.
    expect(editor.view.dispatch).not.toHaveBeenCalled()
  })
})
