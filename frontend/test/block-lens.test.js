// @ts-check
// BlockLens — the lens a block container gets when its kind has none of its
// own. It is mounted over the real read-only provider (ProviderAdapter over a
// ContainerModel), so what is pinned is the whole path from a load answer and an
// attrs echo to what is drawn, and that nothing it does can write.

import { describe, it, expect, afterEach } from 'vitest'
import { BlockLens } from '../src/static/lens/block/block-lens.js'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import '../src/static/renderers/block-renderers.js'

const UUID = '0190a0a0-0000-7000-8000-000000000001'

/** A BlockLens presented over a container holding one block of `kind`. */
async function presented(kind, attrs) {
  const model = new ContainerModel(UUID, kind)
  model.applyLoad({ uuid: UUID, blocks: [{ id: UUID, kind: kind, attrs: Object.assign({ id: UUID }, attrs) }] })
  const lens = new BlockLens(UUID, { provider: new ProviderAdapter(model) })
  const root = document.createElement('div')
  document.body.appendChild(root)
  await lens.presentMode('wysiwyg', root)
  return { model, lens, root }
}

describe('BlockLens', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it("draws the container's block through its kind's renderer, as a record", async () => {
    const { lens, root } = await presented('code', { source: 'x := 1', language: 'go', title: 'a snippet' })
    expect(lens.mode).toBe('block')
    const block = root.querySelector('[data-kind="code"]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('x := 1')
    expect(root.querySelector('.block-record__card')).toBeNull()
    expect(root.querySelector('[contenteditable="true"], textarea, input:not([readonly])')).toBeNull()
  })

  it('draws a card naming the kind and the title for a kind nothing draws', async () => {
    const { root } = await presented('a-kind-nothing-draws', { title: 'Shopping list' })
    const card = root.querySelector('.block-record__card')
    expect(card?.querySelector('.block-record__kind')?.textContent).toBe('a-kind-nothing-draws')
    expect(card?.querySelector('.block-record__title')?.textContent).toBe('Shopping list')
  })

  it('repaints from the provider when the container changes', async () => {
    const { model, root } = await presented('a-kind-nothing-draws', { title: 'before' })
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: UUID, attrs: { title: 'after' } })
    expect(root.querySelector('.block-record__title')?.textContent).toBe('after')
  })

  it('is read-only by construction: no capability, and no verb reaches the provider', async () => {
    const { lens } = await presented('code', { source: 'x := 1' })
    expect(lens.getCapabilities()).toEqual({ markdown: false, mentions: false, commands: false, blocks: false })
    expect(lens.canEditBlocks).toBe(false)
    const provider = /** @type {any} */ (lens.provider)
    for (const verb of ['requestAddBlock', 'requestSetBlock', 'requestRemoveBlock', 'requestReplaceText', 'requestPersist', 'setContents', 'flushContents', 'paste']) {
      expect(typeof provider[verb]).toBe('undefined')
    }
    lens.createBlock('code', {})
    lens.replaceText({ blockId: UUID }, 'y')
    lens.setRawContent('raw')
    await lens.flushSave()
    expect(await lens.setMode('markdown')).toBe(false)
  })

  it('destroy empties the root and stops following the container', async () => {
    const { model, lens, root } = await presented('a-kind-nothing-draws', { title: 'before' })
    lens.destroy()
    expect(root.childElementCount).toBe(0)
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: UUID, attrs: { title: 'after' } })
    expect(root.childElementCount).toBe(0)
  })
})
