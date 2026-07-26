// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CommandHintPopover } from '../src/static/shell/command-hint-popover.js'

function mountDom() {
  document.body.innerHTML = `
    <div id="ask-panel">
      <textarea class="ask-popup__input"></textarea>
    </div>
  `
  return {
    panel: document.getElementById('ask-panel'),
    textarea: document.querySelector('.ask-popup__input')
  }
}

describe('CommandHintPopover', () => {
  let textarea
  let popover
  let commands

  beforeEach(() => {
    const dom = mountDom()
    textarea = dom.textarea
    commands = [
      { name: 'btw', description: 'Ask by the way' },
      { name: 'buffer', description: 'Buffer doc' }
    ]
    popover = new CommandHintPopover(textarea, {
      list: () => commands
    })
  })

  afterEach(() => {
    popover.destroy()
    document.body.innerHTML = ''
  })

  it('shows matching commands when typing slash prefix', () => {
    textarea.value = '/b'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    const el = document.querySelector('.command-hint-popover')
    expect(el).not.toBeNull()
    expect(el.style.display).not.toBe('none')

    const items = el.querySelectorAll('.command-hint-item')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('/btw')
    expect(items[1].textContent).toContain('/buffer')
  })

  it('filters commands according to input prefix', () => {
    textarea.value = '/btw'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    const el = document.querySelector('.command-hint-popover')
    const items = el.querySelectorAll('.command-hint-item')
    expect(items.length).toBe(1)
    expect(items[0].textContent).toContain('/btw')
  })

  it('hides when input is cleared or does not start with slash', () => {
    textarea.value = '/b'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    textarea.value = 'hello'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    const el = document.querySelector('.command-hint-popover')
    expect(el.style.display).toBe('none')
  })

  it('completes highlighted command on Tab or Enter', () => {
    textarea.value = '/bt'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)

    expect(textarea.value).toBe('/btw ')
    expect(textarea.selectionStart).toBe('/btw '.length)
    expect(textarea.selectionEnd).toBe('/btw '.length)
    const el = document.querySelector('.command-hint-popover')
    expect(el.style.display).toBe('none')
  })

  it('navigates options with ArrowDown and ArrowUp', () => {
    textarea.value = '/b'
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))

    const el = document.querySelector('.command-hint-popover')
    let active = el.querySelector('.command-hint-item.is-active')
    expect(active.textContent).toContain('/btw')

    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    active = el.querySelector('.command-hint-item.is-active')
    expect(active.textContent).toContain('/buffer')

    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    active = el.querySelector('.command-hint-item.is-active')
    expect(active.textContent).toContain('/btw')
  })
})
