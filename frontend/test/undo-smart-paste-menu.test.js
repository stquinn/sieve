import { describe, it, expect } from 'vitest'
// labelForAction is the small pure map extracted from detectAndAppendExtractions.
import { labelForAction } from '../src/static/action-label.js'

describe('action menu labels', () => {
  it('labels undo-smart-paste as "Undo Smart Paste"', () => {
    expect(labelForAction('undo-smart-paste', 'Code')).toBe('Undo Smart Paste')
  })
  it('labels prose transform as "Embed in Document"', () => {
    expect(labelForAction('transform', 'Text', { kind: 'prose' })).toBe('Embed in Document')
  })
  it('labels extract as "Extract as <kind>"', () => {
    expect(labelForAction('extract', 'Code')).toBe('Extract as Code')
  })
})
