import { describe, it, expect } from 'vitest'
// labelForAction is the small pure map extracted from detectAndAppendExtractions.
import { labelForAction } from '../src/static/renderers/action-label.js'

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
  it('labels image→prose extract as "Extract as Raw Image" (source-kind aware)', () => {
    // The image extracts as a raw image, not text, so the generic "Extract as
    // Text" misreads. The source kind (4th arg) drives this, not prettyKind.
    expect(labelForAction('extract', 'Text', { kind: 'prose' }, 'smart-image'))
      .toBe('Extract as Raw Image')
  })
  it('keeps generic prose extract label when source is not an image', () => {
    expect(labelForAction('extract', 'Text', { kind: 'prose' }, 'code'))
      .toBe('Extract as Text')
  })
  it('keeps generic prose transform as "Embed in Document"', () => {
    expect(labelForAction('transform', 'Text', { kind: 'prose' }, 'smart-image'))
      .toBe('Embed in Document')
  })
})
