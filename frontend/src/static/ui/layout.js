// @ts-check
// layout.js — SessionLayout: manages panel layout resizing, layout state
// synchronization between #session-layout and #app-root, and WebKit shortcut
// interception.

export class SessionLayout {
  /** @type {HTMLElement|null} */
  #appRoot = null

  /** @type {boolean} */
  #isDragging = false

  /** @type {HTMLElement|null} */
  #currentHandle = null

  /** @type {number} */
  #startX = 0

  /** @type {number} */
  #startY = 0

  /** @type {number} */
  #startWidth = 0

  /** @type {number} */
  #startHeight = 0

  /** @type {(e: MouseEvent) => void} */
  #onMouseMoveBound

  /** @type {() => void} */
  #onMouseUpBound

  /**
   * @param {HTMLElement|null} [root]
   */
  constructor(root = (typeof document !== 'undefined' ? document.getElementById('app-root') : null)) {
    this.#appRoot = root
    this.#onMouseMoveBound = (e) => this.#onMouseMove(e)
    this.#onMouseUpBound = () => this.#onMouseUp()
  }

  /**
   * Synchronises panel layout state from #session-layout onto #app-root.
   * @param {HTMLElement|null} [layoutEl]
   */
  sync(layoutEl = (typeof document !== 'undefined' ? document.getElementById('session-layout') : null)) {
    const root = this.#appRoot || (typeof document !== 'undefined' ? document.getElementById('app-root') : null)
    if (!root || !layoutEl || !layoutEl.dataset) return
    if (layoutEl.dataset.meta) {
      root.setAttribute('data-meta', layoutEl.dataset.meta)
    }
  }

  /**
   * Evaluates whether a keydown event matches the Mod+Alt+I chord.
   * On macOS, Option+I generates a dead circumflex accent ('Dead' or 'ˆ'),
   * so event.code ('KeyI') is checked alongside event.key.
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  static isToggleMetaChord(e) {
    if (!e) return false
    const isMod = typeof window !== 'undefined' && typeof window.isMod === 'function'
      ? window.isMod(e)
      : (typeof navigator !== 'undefined' && navigator.platform && navigator.platform.includes('Mac') ? Boolean(e.metaKey) : Boolean(e.ctrlKey))
    return Boolean(isMod && e.altKey && (e.code === 'KeyI' || e.key === 'i' || e.key === 'I'))
  }

  /**
   * Handles capture-phase keydown to intercept Mod+Alt+I before WebKit opens Web Inspector.
   * @param {KeyboardEvent} e
   * @returns {boolean} true if intercepted and handled
   */
  handleKeyDown(e) {
    if (SessionLayout.isToggleMetaChord(e)) {
      e.preventDefault()
      if (typeof window !== 'undefined' && window.htmx) {
        window.htmx.ajax('POST', '/api/session/toggle/meta', { swap: 'none' })
      }
      return true
    }
    return false
  }

  /**
   * @param {MouseEvent} e
   */
  onMouseDown(e) {
    const handle = e.target
    if (!handle || !(handle instanceof HTMLElement)) return
    if (!handle.classList.contains('sidebar-handle') &&
        !handle.classList.contains('meta-handle') &&
        !handle.classList.contains('prompts-handle') &&
        !handle.classList.contains('ask-handle')) return

    this.#currentHandle = handle
    this.#isDragging = true
    this.#startX = e.clientX
    this.#startY = e.clientY

    const sidebarWrapper = document.getElementById('sidebar-wrapper')
    const metaPanel = document.getElementById('htmx-meta-panel')
    const promptsPanel = document.getElementById('prompts-panel')
    const askPanel = document.getElementById('ask-panel')

    if (handle.classList.contains('sidebar-handle')) {
      this.#startWidth = sidebarWrapper ? sidebarWrapper.offsetWidth : 0
    } else if (handle.classList.contains('meta-handle')) {
      this.#startWidth = metaPanel ? metaPanel.offsetWidth : 0
    } else if (handle.classList.contains('prompts-handle')) {
      this.#startHeight = promptsPanel ? promptsPanel.offsetHeight : 0
    } else if (handle.classList.contains('ask-handle')) {
      this.#startHeight = askPanel ? askPanel.offsetHeight : 0
    }

    document.body.style.cursor = window.getComputedStyle(handle).cursor
    document.body.classList.add('is-resizing')

    document.addEventListener('mousemove', this.#onMouseMoveBound)
    document.addEventListener('mouseup', this.#onMouseUpBound)
    e.preventDefault()
  }

  /**
   * @param {string} varName
   * @param {string} value
   */
  #setLayoutVar(varName, value) {
    const root = this.#appRoot || (typeof document !== 'undefined' ? document.getElementById('app-root') : null)
    if (root) {
      root.style.setProperty(varName, value)
    }
  }

  /**
   * @param {MouseEvent} e
   */
  #onMouseMove(e) {
    if (!this.#isDragging || !this.#currentHandle) return

    if (this.#currentHandle.classList.contains('sidebar-handle')) {
      const dx = e.clientX - this.#startX
      let newWidth = this.#startWidth + dx
      if (newWidth < 150) newWidth = 150
      if (newWidth > 600) newWidth = 600
      this.#setLayoutVar('--sidebar-w', newWidth + 'px')
    } else if (this.#currentHandle.classList.contains('meta-handle')) {
      const dx = this.#startX - e.clientX
      let newWidth = this.#startWidth + dx
      if (newWidth < 150) newWidth = 150
      if (newWidth > 600) newWidth = 600
      this.#setLayoutVar('--meta-w', newWidth + 'px')
    } else if (this.#currentHandle.classList.contains('prompts-handle')) {
      const dy = this.#startY - e.clientY
      let newHeight = this.#startHeight + dy
      if (newHeight < 50) newHeight = 50
      if (newHeight > 600) newHeight = 600
      this.#setLayoutVar('--prompts-h', newHeight + 'px')
    } else if (this.#currentHandle.classList.contains('ask-handle')) {
      const askPanel = document.getElementById('ask-panel')
      const dy = this.#startY - e.clientY
      let newHeight = this.#startHeight + dy
      const min = this.#askPanelMinHeight(askPanel)
      const editorCol = document.getElementById('editor-col')
      const max = editorCol ? Math.max(min, editorCol.clientHeight - 100) : 600
      if (newHeight < min) newHeight = min
      if (newHeight > max) newHeight = max
      this.#setLayoutVar('--ask-panel-h', newHeight + 'px')
    }
  }

  /**
   * @param {HTMLElement|null} askPanel
   */
  #askPanelMinHeight(askPanel) {
    if (!askPanel) return 0
    const footer = askPanel.querySelector('.ask-popup__footer')
    const input = askPanel.querySelector('.ask-popup__input')
    const handle = askPanel.querySelector('.ask-handle')
    const cs = input ? getComputedStyle(input) : null
    const lineH = cs ? (parseFloat(cs.lineHeight) || 22) : 22
    const padV = cs ? (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) : 0
    const footerH = footer instanceof HTMLElement ? footer.offsetHeight : 0
    const handleH = handle instanceof HTMLElement ? handle.offsetHeight : 0
    const frameV = this.#verticalFrame(askPanel.querySelector('.ask-composer'))
    return Math.ceil(footerH + handleH + frameV + lineH + padV)
  }

  /**
   * @param {Element|null} el
   */
  #verticalFrame(el) {
    if (!el) return 0
    const cs = getComputedStyle(el)
    return ['marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth']
      .reduce((sum, prop) => sum + (parseFloat(cs[prop]) || 0), 0)
  }

  #onMouseUp() {
    if (!this.#isDragging) return
    this.#isDragging = false
    document.body.style.cursor = ''
    document.body.classList.remove('is-resizing')
    document.removeEventListener('mousemove', this.#onMouseMoveBound)
    document.removeEventListener('mouseup', this.#onMouseUpBound)

    const root = this.#appRoot || (typeof document !== 'undefined' ? document.getElementById('app-root') : null)
    const promptsPanel = document.getElementById('prompts-panel')
    const askPanel = document.getElementById('ask-panel')

    const sidebarWidth = root ? parseInt(getComputedStyle(root).getPropertyValue('--sidebar-w')) || 0 : 0
    const metaWidth = root ? parseInt(getComputedStyle(root).getPropertyValue('--meta-w')) || 0 : 0
    const promptsHeight = promptsPanel ? promptsPanel.offsetHeight : 0
    const askPanelHeight = askPanel ? askPanel.offsetHeight : 0

    const params = new URLSearchParams()
    params.append('sidebarWidth', String(sidebarWidth))
    params.append('metaWidth', String(metaWidth))
    params.append('promptsHeight', String(promptsHeight))
    params.append('askPanelHeight', String(askPanelHeight))

    fetch('/api/session/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    })
  }

  bindListeners() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    window.addEventListener('keydown', (e) => this.handleKeyDown(e), { capture: true })

    window.addEventListener('DOMContentLoaded', () => this.sync())

    document.addEventListener('htmx:load', (e) => {
      // @ts-ignore
      const el = (e.detail && e.detail.elt) || e.target
      if (el && (el.id === 'session-layout' || (el.querySelector && el.querySelector('#session-layout')))) {
        this.sync(el.id === 'session-layout' ? el : el.querySelector('#session-layout'))
      }
    })

    document.addEventListener('htmx:afterSettle', (e) => {
      // @ts-ignore
      const target = (e.detail && e.detail.target) || e.target
      if (target && (target.id === 'session-layout' || (target.querySelector && target.querySelector('#session-layout')))) {
        this.sync()
      }
    })

    document.addEventListener('mousedown', (e) => this.onMouseDown(e))
  }
}

if (typeof document !== 'undefined') {
  const layout = new SessionLayout()
  layout.bindListeners()
}
