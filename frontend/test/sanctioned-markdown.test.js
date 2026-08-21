// @ts-check
// sanctioned-markdown.test.js — DoD coverage for
// block/renderers/sanctioned-markdown.js, the dedicated html:false
// markdown-it instance every renderer fill (title, body) runs on
// (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md §Content lanes
// / §Body/title pull-back — DEFECT SEC-B, issue #48). Uses the REAL
// markdown-it / markdown-it-mark packages (not a mock) so this suite would
// actually fail if the sanctioned instance ever regressed to html:true or
// lost the mark plugin.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
// markdown-it-mark ships no type declarations (a plain-JS plugin package).
// @ts-ignore — TS7016, no .d.ts for this module
import markdownItMark from 'markdown-it-mark'

describe('sanctioned-markdown', () => {
  beforeEach(() => {
    // The semicolon after resetModules() is load-bearing: without it, ASI
    // does NOT insert one before the next line's leading `(...)` cast, so the
    // parser would read `vi.resetModules()(globalThis)...` as one call chain.
    vi.resetModules();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt, markdownItMark })
  })

  it('preserves markdown feature parity: emphasis, inline code, links, ==mark==', async () => {
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    const html = renderSanctionedMarkdown('*em* `code` [link](https://example.com) ==marked==')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://example.com">link</a>')
    expect(html).toContain('<mark>marked</mark>')
  })

  it('SECURITY (DEFECT SEC-B, #48): html:false — raw HTML embedded in markdown text renders escaped/inert, never live DOM', async () => {
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    const hostile = 'before <img src=x onerror="window.__pwned = true"> after'
    const html = renderSanctionedMarkdown(hostile)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('SECURITY (DEFECT SEC-B, #48): a <script> tag embedded in markdown text also renders inert', async () => {
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    const html = renderSanctionedMarkdown('<script>window.__pwned2 = true</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('falls back to HTML-escaped plain text when the vendor MarkdownIt export is unavailable', async () => {
    delete /** @type {any} */ (globalThis).TipTap.MarkdownIt
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    const html = renderSanctionedMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('points a relative image src at the store file route, and leaves every other src alone', async () => {
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    // A rendered fill is injected into the app shell, so a relative src would
    // otherwise be resolved against the shell's own URL and 404.
    expect(renderSanctionedMarkdown('![d](diagrams/flow.png)'))
      .toContain('src="/ui/files/diagrams/flow.png"')
    expect(renderSanctionedMarkdown('![a](/ui/assets/doc-1/pic.png)'))
      .toContain('src="/ui/assets/doc-1/pic.png"')
    expect(renderSanctionedMarkdown('![r](https://example.com/x.png)'))
      .toContain('src="https://example.com/x.png"')
  })

  it('keeps the image alt text markdown-it produced (the rule delegates, it does not re-render)', async () => {
    const { renderSanctionedMarkdown } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    expect(renderSanctionedMarkdown('![the flow](diagrams/flow.png "t")'))
      .toContain('alt="the flow"')
  })

  it('sanctionedMarkdownIt() constructs the instance lazily and caches it (register the mark plugin exactly once)', async () => {
    const useSpy = vi.spyOn(MarkdownIt.prototype, 'use')
    const { sanctionedMarkdownIt } = await import('../src/static/block/renderers/sanctioned-markdown.js')
    const first = sanctionedMarkdownIt()
    const second = sanctionedMarkdownIt()
    expect(first).toBe(second)
    expect(useSpy).toHaveBeenCalledTimes(1)
    useSpy.mockRestore()
  })
})
