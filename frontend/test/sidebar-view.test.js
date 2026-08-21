// @ts-check
// sidebar-view.test.js — the sidebar's MODE survives an invalidation refetch.
//
// #htmx-sidebar carries ONE hard-wired hx-get="/ui/views/sidebar" (the tree)
// fired by sieve:invalidate-notes / sieve:invalidate-session. The search panel
// is swapped into that same container, so opening a file — which adds a tab and
// therefore invalidates `session` — used to refetch the tree and destroy the
// search mid-flow (issue #93).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SidebarView } from '../src/static/shell/sidebar-view.js'

/** The htmx:configRequest detail shape this class reads (htmx 2.0.10). */
function configRequest(elt, path) {
  const detail = { elt, path, parameters: /** @type {Record<string, any>} */ ({}), verb: 'get' }
  elt.dispatchEvent(new CustomEvent('htmx:configRequest', { detail, bubbles: true }))
  return detail
}

describe('SidebarView — mode survives the invalidation refetch', () => {
  /** @type {SidebarView} */ let view
  /** @type {HTMLElement} */ let sidebar

  beforeEach(() => {
    document.body.innerHTML = '<div id="htmx-sidebar"></div>'
    sidebar = /** @type {HTMLElement} */ (document.getElementById('htmx-sidebar'))
    view = new SidebarView().attach()
  })

  afterEach(() => { view.detach(); document.body.innerHTML = '' })

  /** Mounts the search panel into the container, as the search swap does. */
  function mountSearch(query) {
    sidebar.innerHTML =
      '<div class="store-search">' +
      '<button class="store-search__close"></button>' +
      '<input id="sidebar-search-input" class="store-search__input" value="' + query + '">' +
      '</div>'
    const input = /** @type {HTMLInputElement} */ (sidebar.querySelector('.store-search__input'))
    input.value = query
    return input
  }

  it('leaves the tree refetch alone in tree mode', () => {
    sidebar.innerHTML = '<div class="sidebar__file"></div>'
    const d = configRequest(sidebar, '/ui/views/sidebar')
    expect(d.path).toBe('/ui/views/sidebar')
    expect(d.parameters.q).toBeUndefined()
  })

  it('rewrites the container refetch to the search view, carrying the live query', () => {
    mountSearch('plan')
    const d = configRequest(sidebar, '/ui/views/sidebar')
    expect(d.path).toBe('/ui/views/sidebar/search')
    expect(d.parameters.q).toBe('plan')
  })

  it('carries an empty query rather than dropping the parameter', () => {
    mountSearch('')
    const d = configRequest(sidebar, '/ui/views/sidebar')
    expect(d.path).toBe('/ui/views/sidebar/search')
    expect(d.parameters.q).toBe('')
  })

  it('leaves the panel-owned Close Search request alone, so search still closes', () => {
    mountSearch('plan')
    const close = /** @type {HTMLElement} */ (sidebar.querySelector('.store-search__close'))
    const d = configRequest(close, '/ui/views/sidebar')
    expect(d.path).toBe('/ui/views/sidebar')
  })

  it('never rewrites a request that is not the tree fetch', () => {
    mountSearch('plan')
    const d = configRequest(sidebar, '/ui/views/sidebar/search')
    expect(d.path).toBe('/ui/views/sidebar/search')
    expect(d.parameters.q).toBeUndefined()
  })
})
