// @ts-check

/**
 * SidebarView — keeps the sidebar in the MODE the user put it in (tree or
 * library search) across an invalidation refetch.
 *
 * #htmx-sidebar carries ONE hard-wired `hx-get="/ui/views/sidebar"` — the tree —
 * fired by `sieve:invalidate-notes` / `sieve:invalidate-session`. The search
 * panel is swapped into that SAME container, so without re-pointing that request
 * any tab change, rename or delete refetches the tree over live search results.
 *
 * The container is the only element whose request is rewritten. The panel's own
 * "Close Search" button issues the identical GET from a DIFFERENT elt, and that
 * one must go through untouched or search could never be closed.
 *
 * Focus and caret need no handling here: htmx restores both to the element with
 * the same id after a swap, and the re-rendered input keeps `sidebar-search-input`.
 */
export class SidebarView {
  static SIDEBAR_ID = 'htmx-sidebar'
  static TREE_PATH = '/ui/views/sidebar'
  static SEARCH_PATH = '/ui/views/sidebar/search'

  /** @type {EventTarget} */ #root
  /** @type {(e: Event) => void} */ #onConfigRequest

  /** @param {EventTarget} [root] the event root to listen on (the document in the app; injectable for tests) */
  constructor(root) {
    this.#root = root || document
    this.#onConfigRequest = (e) => this.#retarget(/** @type {CustomEvent} */ (e).detail)
  }

  /** @returns {this} */
  attach() {
    this.#root.addEventListener('htmx:configRequest', this.#onConfigRequest)
    return this
  }

  /** @returns {this} */
  detach() {
    this.#root.removeEventListener('htmx:configRequest', this.#onConfigRequest)
    return this
  }

  /**
   * The live query when the search panel is mounted, or null in tree mode. The
   * INPUT is the truth, not a field on this class: the panel is server-rendered
   * markup a swap can replace at any moment, so a remembered query would drift.
   * @returns {string|null}
   */
  #liveQuery() {
    const input = /** @type {HTMLInputElement|null} */ (
      document.querySelector('#' + SidebarView.SIDEBAR_ID + ' .store-search__input'))
    return input ? input.value : null
  }

  /**
   * Rewrites the container's tree refetch into a search refetch while search is
   * open. htmx reads `path` and `parameters` back off the detail after the event,
   * so mutating them here re-points the request the container already armed.
   * @param {{elt?: Element, path?: string, parameters?: Record<string, any>}} detail
   */
  #retarget(detail) {
    if (!detail || !detail.elt || detail.elt.id !== SidebarView.SIDEBAR_ID) return
    if (detail.path !== SidebarView.TREE_PATH) return
    const query = this.#liveQuery()
    if (query === null) return
    detail.path = SidebarView.SEARCH_PATH
    if (detail.parameters) detail.parameters.q = query
  }
}
