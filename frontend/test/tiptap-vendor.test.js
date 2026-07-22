// @ts-check
// tiptap-vendor.test.js — pins the vendor-seam contract (P4.E D-1):
// `T` is a live bag over the vendor global. Tests stub members by mutating
// globalThis.TipTap (installed by test/setup.js); they must never reassign it.
import { describe, it, expect, afterEach } from 'vitest'
import { T } from '../src/static/editor/surfaces/tiptap-vendor.js'

describe('tiptap-vendor bag (the ONE sanctioned vendor-global read)', () => {
  afterEach(() => {
    delete /** @type {any} */ (globalThis.TipTap).__p4eProbe
  })

  it('T is the same object as globalThis.TipTap (shared with test setup)', () => {
    expect(T).toBe(globalThis.TipTap)
  })

  it('members stubbed onto globalThis.TipTap after import are visible through T (live reads)', () => {
    const probe = () => 'p4e'
    Object.assign(/** @type {any} */ (globalThis.TipTap), { __p4eProbe: probe })
    expect(/** @type {any} */ (T).__p4eProbe).toBe(probe)
  })
})
