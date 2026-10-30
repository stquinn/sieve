// @ts-check
// AssetPlacement — the Assets tab's Insert and drag. Both build the same paste:
// an asset the row names a holder for travels as that block's sieve view (the
// server shares the file and carries the description), any other as its address
// (the server adopts the file).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { AssetPlacement } from '../src/static/shell/asset-placement.js'
import { ASSET_DRAG_TYPE } from '../src/static/contract/container-provider.js'

const DOC = 'doc-1'
const ADDRESS = 'sieve://doc-1/holiday.png'
const HOLDER = { id: 'img-1', kind: 'smart-image', attrs: { id: 'img-1', src: ADDRESS, title: 'holiday.png', summary: 'A beach' } }
const FILE_HOLDER = { id: 'ref-1', kind: 'reference', attrs: { id: 'ref-1', uri: 'sieve://doc-1/plan.pdf', cache: { title: 'plan.pdf', mime: 'application/pdf' } } }

function workspace({ uuid = DOC, blocks = [HOLDER, FILE_HOLDER] } = {}) {
  const editor = { pasteEntries: vi.fn(() => Promise.resolve('block')) }
  const provider = { getBlock: vi.fn((id) => blocks.find((b) => b.id === id) || null) }
  return { editor, provider, ws: { activeTab: { uuid, editor, mount: { provider } }, activeBlockEditor: () => editor } }
}

/** One Assets tab row, as the server renders it. */
function row({ document: doc = DOC, holder = '' } = {}) {
  const list = document.createElement('div')
  list.setAttribute('data-asset-document', doc)
  list.innerHTML = `<div data-asset-row data-asset-address="${ADDRESS}" data-asset-holder="${holder}" draggable="true">
    <button data-asset-insert>Insert</button></div>`
  document.body.appendChild(list)
  return /** @type {HTMLElement} */ (list.firstElementChild)
}

afterEach(() => { document.body.innerHTML = '' })

describe('AssetPlacement.entriesFor', () => {
  it.each([
    ['an unused asset is its address', '', null, [{ mimeType: 'text/uri-list', content: ADDRESS }]],
    ['an asset whose holder the document no longer holds is its address', 'img-1', { blocks: [] }, [{ mimeType: 'text/uri-list', content: ADDRESS }]],
    ['an asset a smart-image holds is that block\'s view', 'img-1', null, [{
      mimeType: 'sieve/smart-image',
      content: JSON.stringify(Object.assign({}, HOLDER.attrs, { kind: 'smart-image' })),
      context: { container: DOC },
    }]],
    ['a file a reference holds is that block\'s view', 'ref-1', null, [{
      mimeType: 'sieve/reference',
      content: JSON.stringify(Object.assign({}, FILE_HOLDER.attrs, { kind: 'reference' })),
      context: { container: DOC },
    }]],
  ])('%s', (_name, holder, wsOpts, want) => {
    const { ws } = workspace(wsOpts || {})
    expect(new AssetPlacement(ws).entriesFor(row({ holder }))).toEqual(want)
  })

  it('nothing when the row is another document\'s', () => {
    const { ws } = workspace()
    expect(new AssetPlacement(ws).entriesFor(row({ document: 'doc-2' }))).toBeNull()
  })
})

describe('AssetPlacement gestures, delegated from a stable ancestor', () => {
  it('Insert hands the entries to the active editor', () => {
    const { ws, editor } = workspace()
    const placement = new AssetPlacement(ws).attach()
    row().querySelector('[data-asset-insert]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(editor.pasteEntries).toHaveBeenCalledWith([{ mimeType: 'text/uri-list', content: ADDRESS }])
    placement.detach()
  })

  it('a drag carries the same entries under the private type', () => {
    const { ws } = workspace()
    const placement = new AssetPlacement(ws).attach()
    const setData = vi.fn()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } })
    row({ holder: 'img-1' }).dispatchEvent(event)
    expect(setData).toHaveBeenCalledWith(ASSET_DRAG_TYPE, JSON.stringify(new AssetPlacement(ws).entriesFor(document.querySelector('[data-asset-row]'))))
    expect(event.defaultPrevented).toBe(false)
    placement.detach()
  })

  it('a drag with nothing to place is refused', () => {
    const { ws } = workspace()
    const placement = new AssetPlacement(ws).attach()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '' } })
    row({ document: 'doc-2' }).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    placement.detach()
  })
})
