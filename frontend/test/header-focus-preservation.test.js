import { describe, it, expect, beforeEach } from 'vitest'
import { adoptFocusedControl, restoreFocusedControl } from '../src/static/block/sieve-block-extension.js'

// The header re-render (renderHeaderBar) rebuilds the whole toolbar so button
// states track the live attrs. adopt/restoreFocusedControl keep a control the
// user is actively in (log's Filter… input) alive across that rebuild: its live
// DOM node is moved into the fresh tree and re-focused — value + caret intact —
// so re-rendering no longer robs it of focus (the "toolbar doesn't redraw" bug).

// Build a toolbar with two toggle buttons (whose "active" class is the state we
// want to see refresh) and a text input, mirroring log's explore-mode header.
function makeBar(activeCol) {
  const bar = document.createElement('div')
  bar.className = 'sieve-block__header'
  const btn = document.createElement('button')
  btn.className = 'toggle' + (activeCol ? ' toggle--active' : '')
  btn.textContent = 'Col'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'filter'
  bar.appendChild(btn)
  bar.appendChild(input)
  return bar
}

describe('header focus preservation', () => {
  let mount, oldBar
  beforeEach(() => {
    document.body.innerHTML = ''
    mount = document.createElement('div')
    document.body.appendChild(mount)
    oldBar = makeBar(false)
    mount.appendChild(oldBar)
  })

  // renderHeaderBar's swap sequence: adopt (before mount) → mount → restore.
  function swap(fresh) {
    const snap = adoptFocusedControl(oldBar, fresh)
    mount.replaceChild(fresh, oldBar)
    restoreFocusedControl(snap)
    oldBar = fresh
  }

  it('keeps the live focused input (value + caret) while refreshing button state', () => {
    const input = oldBar.querySelector('.filter')
    input.value = 'abc'
    input.focus()
    input.setSelectionRange(2, 2)
    expect(document.activeElement).toBe(input)

    const fresh = makeBar(true) // button state flipped to active
    swap(fresh)

    // Button state refreshed …
    expect(oldBar.querySelector('.toggle').className).toContain('toggle--active')
    // … and the SAME live input is still focused with its value + caret intact.
    const focused = document.activeElement
    expect(focused).toBe(input)
    expect(focused.value).toBe('abc')
    expect(focused.selectionStart).toBe(2)
    // The fresh tree adopted the live node (not its rebuilt twin).
    expect(oldBar.contains(input)).toBe(true)
  })

  it('swaps wholesale when nothing in the header is focused', () => {
    document.body.focus?.()
    const fresh = makeBar(true)
    const snap = adoptFocusedControl(oldBar, fresh)
    expect(snap).toBe(null)
    mount.replaceChild(fresh, oldBar)
    restoreFocusedControl(snap)
    expect(mount.querySelector('.toggle').className).toContain('toggle--active')
  })
})
