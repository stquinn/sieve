import { describe, it, expect } from 'vitest'
import { wrapProseBlock } from '../src/static/prose-markers.js'

// prose-markers is the save-direction symmetry to Go's serializeProseBlock: it
// wraps one top-level prose node's clean markdown in the paired
// <!--s:ID-->…<!--/s:ID--> delimiters so its identity survives a doc-update
// round-trip byte-for-byte. Node-granular: ONE pair per top-level node.
describe('wrapProseBlock', () => {
  it('wraps content in paired open/close markers carrying the id', () => {
    expect(wrapProseBlock('pr-1', 'Hello.')).toBe('<!--s:pr-1-->\nHello.\n<!--/s:pr-1-->')
  })

  it('emits bare content (no markers) when there is no id', () => {
    // A not-yet-minted node round-trips as bare content; Go mints on Open.
    expect(wrapProseBlock('', 'Hello.')).toBe('Hello.')
  })

  it('preserves internal blank lines inside the pair (close tag is what bounds it)', () => {
    const content = 'Para one.\n\nPara two.'
    expect(wrapProseBlock('pr-9', content)).toBe('<!--s:pr-9-->\nPara one.\n\nPara two.\n<!--/s:pr-9-->')
  })
})
