// @ts-check
// The root of the JS component model: it holds the open Tabs, tracks the active
// one, and is the composition root that constructs every service and chrome
// child. Created once at module load and exposed as `window.sieveWorkspace`, the
// only surviving global.

import { SieveTab } from './tab.js'
import { MountBinding } from './mount-binding.js'
import { ContainerModelFeed } from '../container/container-model-feed.js'
import { ContainerTransport } from '../container/container-transport.js'
import { DocumentService } from '../container/document-service.js'
import { SpellControl } from './spell-control.js'
import { WorkspaceService } from './workspace-service.js'
import { CommandService } from './command-service.js'
import { MentionService } from './mention-service.js'
import { InvalidationService } from './invalidation-service.js'
import { CommandBadges } from './command-badges.js'
import { AskPanel } from './ask-panel.js'
import { InsertDialogs } from './insert-dialogs.js'
import { MacroCatalog } from './macro-catalog.js'
import { SearchOverlay } from './search-overlay.js'
import { StatusBar } from './status-bar.js'
import { SidebarView } from './sidebar-view.js'

export class SieveWorkspace {
  /** @type {Map<string, SieveTab>} uuid → Tab */
  #tabs = new Map()

  /** @type {SieveTab|null} */
  #activeTab = null

  /** @type {Array<(tab: SieveTab|null) => void>} */
  #activeTabListeners = []

  /** @type {Array<(ctx: import('../lens/document-editor/selection-model.js').SelectionContext|null) => void>}
   *  republishes the ACTIVE tab's selection stream only. */
  #selectionListeners = []

  /** @type {(() => void)|null} unsubscribe from the ACTIVE tab's onSelectionUpdate */
  #unsubActiveSelection = null

  /** @type {string} the active editor's uuid ('' when torn down). Load-bearing
   * staleness guard: initEditor sets this synchronously before the async load and
   * the load's `.then` re-checks it, so a later init supersedes an in-flight load. */
  #currentUuid = ''

  /** @type {HTMLElement|null} the active editor's mount element. QUIRK PRESERVED
   * (do NOT "fix"): this is NOT cleared on teardown. */
  #currentMountEl = null

  /** @type {string|null} last hovered block key — dedup for editor:blockhover. */
  #lastHoverKey = null

  /** @type {ReturnType<typeof setTimeout>|null} lazy scroll-persist debounce, for the active tab only */
  #scrollPersistTimer = null

  /** @type {ContainerTransport} the app-wide protocol boundary AND wire owner,
   *  constructed HERE and handed down. Never window.*. */
  #blockService

  /** @type {DocumentService} the uuid-addressed half, composed over the wire owner. */
  #documentService

  /** @type {ContainerModelFeed} one follower model per open container. The HOST's
   *  data plane: a lens sees only the provider a MountBinding wraps around it. */
  #feed

  /** @type {WorkspaceService} the workspace command plane's transport, shared by
   *  every tenant. Sibling of #blockService, which owns the document channels. */
  #workspaceService

  /** @type {CommandService} the workspace command plane's slash-command tenant. */
  #commandService

  /** @type {MentionService} the plane's `@`-picker tenant. */
  #mentionService

  /** @type {InvalidationService} the plane's push tenant, held only so it stays
   *  alive: it claims its frames and republishes them as DOM events. */
  #invalidationService

  /** @type {SpellControl} the workspace's spelling verbs, and the toggle's state. */
  #spell

  /** @type {MacroCatalog} what this host offers a `{` picker: the block kinds,
   *  plus the URL verbs it owns the dialogs for. Built ONCE — a surface composes
   *  its own presets onto a read of it, and registers nothing. */
  #macroCatalog

  /**
   * @param {import('../container/container-transport.js').ContainerTransportOptions} [serviceOptions]
   *   the ContainerTransport test seams (socketFactory / wsUrlFor). EMPTY in prod.
   */
  constructor(serviceOptions) {
    this.#blockService = new ContainerTransport(serviceOptions)
    this.#documentService = new DocumentService(this.#blockService)
    this.#feed = new ContainerModelFeed(this.#documentService)
    this.#workspaceService = new WorkspaceService({ socketFactory: serviceOptions?.socketFactory })
    this.#commandService = new CommandService(this.#workspaceService, {
      commands: typeof window !== 'undefined' ? /** @type {any} */ (window).__sieveCommands || [] : [],
    })
    this.#mentionService = new MentionService(this.#workspaceService)
    // Constructed with its siblings, and before anything can open the socket
    // lazily: the server pushes the jobs snapshot the instant a socket connects,
    // and a tenant registering later would have that first frame dropped.
    this.#invalidationService = new InvalidationService(this.#workspaceService)
    this.#spell = new SpellControl(this.#workspaceService,
      typeof window !== 'undefined' ? /** @type {any} */ (window).__sieveSpellcheckEnabled !== false : true)
    this.#macroCatalog = new MacroCatalog(this)
  }

  get blockService() { return this.#blockService }

  get documentService() { return this.#documentService }

  get workspaceService() { return this.#workspaceService }

  get commandService() { return this.#commandService }

  get mentionService() { return this.#mentionService }

  get macroCatalog() { return this.#macroCatalog }

  get spell() { return this.#spell }

  /** @param {string} uuid @returns {SieveTab|null} */
  getTab(uuid) {
    return this.#tabs.get(uuid) ?? null
  }

  /** Opens (creates) a Tab for the uuid if not already tracked, marks it active.
   *  @param {string} uuid @returns {SieveTab} */
  openTab(uuid) {
    if (!uuid) throw new Error('SieveWorkspace.openTab: uuid is required')
    let tab = this.#tabs.get(uuid)
    if (!tab) {
      tab = new SieveTab(uuid)
      this.#tabs.set(uuid, tab)
    }
    this.#setActiveTab(tab)
    return tab
  }

  /** Closes the Tab for a uuid. If it was active, activeTab becomes null.
   *  @param {string} uuid */
  closeTab(uuid) {
    const tab = this.#tabs.get(uuid)
    if (!tab) return
    this.#tabs.delete(uuid)
    if (this.#activeTab === tab) {
      this.#activeTab = null
      this.#switchSelectionSource(null)
      this.#notifyActiveTabListeners()
    }
  }

  /** @returns {SieveTab|null} */
  get activeTab() { return this.#activeTab }

  // These are the ONLY front-end entry points for tab mutation and the tabbar
  // render. Each is a thin owner over an htmx.ajax call, guards htmx, and returns
  // its promise.

  /**
   * Opens (or focuses) the document for a uuid, swapping the tabbar. The server
   * re-renders the strip and OOB-mounts the editor, whose re-init drives
   * activateDocument — so there is no client prune here.
   * @param {string} uuid @returns {Promise<any>}
   */
  open(uuid) {
    // RAW id in the path: chi.URLParam does not unescape and the Go handlers
    // compare against decoded ids, so a `prompt:` uuid must arrive with a literal
    // colon. Percent-encoding it makes prompt opens 404.
    return this.#ajax('POST', '/api/note/open/' + uuid)
  }

  /**
   * Opens what a Sieve COORDINATE points at — the verb behind clicking a mention.
   * `uri` is OPAQUE to every line of this file: Go owns the address grammar, so
   * this asks rather than parses.
   * @param {string} uri @returns {Promise<boolean>} whether a document was opened
   */
  async openAddress(uri) {
    const target = await this.#mentionService.resolve(uri)
    if (!target || !target.found || !target.uuid) {
      if (uri) console.warn('[workspace] address opens nothing:', uri, target && target.error)
      return false
    }
    await this.open(target.uuid)
    return true
  }

  /** @returns {Promise<any>} */
  newNote() {
    return this.#ajax('POST', '/api/note')
  }

  /** @param {string} uuid @returns {Promise<any>} */
  close(uuid) { return this.#closeTabs([uuid]) }

  /** @returns {Promise<any>|void} */
  closeActiveTab() {
    if (this.#activeTab) return this.close(this.#activeTab.uuid)
  }

  /** The authoritative list of ALL open tab ids, read from the rendered strip and
   *  NOT #tabs: #tabs holds only tabs ACTIVATED this session, so one loaded from
   *  the session but never clicked has no entry.
   *  @returns {string[]} */
  #openTabIds() {
    return Array.from(document.querySelectorAll('#tabs-area [data-tab-id]'))
      .map((el) => /** @type {HTMLElement} */ (el).dataset.tabId)
      .filter((id) => !!id)
  }

  /** Closes every open tab. The server empties the session and mints one fresh
   *  note; the funnel prunes the old identities. @returns {Promise<any>} */
  closeAll() { return this.#closeTabs(this.#openTabIds()) }

  /** @param {string} keepUuid @returns {Promise<any>} */
  closeOthers(keepUuid) {
    return this.#closeTabs(this.#openTabIds().filter((u) => u !== keepUuid))
  }

  /**
   * The ONE close path: POST the id SET as JSON. The server owns which tabs close,
   * the active-tab re-point, the Smart-Close filing and the
   * empty-becomes-fresh-note. Applied with htmx.swap rather than htmx.ajax so the
   * body can be JSON, and the closed identities are pruned in afterSettleCallback
   * — AFTER the OOB editor mount has destroyed the outgoing editor while
   * #activeTab still pointed at it. Pruning earlier nulls #activeTab first and
   * leaks that editor.
   * @param {string[]} uuids @returns {Promise<any>}
   */
  #closeTabs(uuids) {
    if (!window.htmx || !uuids.length) return Promise.resolve()
    return fetch('/api/tabs/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: uuids }),
    })
      .then((res) => res.text())
      .then((html) => {
        window.htmx.swap('#htmx-tabbar', html, { swapStyle: 'innerHTML' }, {
          afterSettleCallback: () => { for (const uuid of uuids) this.closeTab(uuid) },
        })
      })
  }

  /**
   * @param {number} fromIdx — source tab index
   * @param {number} toPos — target insertion position
   * @returns {Promise<any>}
   */
  reorder(fromIdx, toPos) {
    return this.#ajax('POST', '/api/tabs/reorder', { values: { from: fromIdx, to: toPos } })
  }

  /** Fetches and renders the tab strip. The boot and invalidation refetch entry
   *  point — #htmx-tabbar carries no hx-get/hx-trigger of its own.
   *  @returns {Promise<any>} */
  loadTabs() {
    return this.#ajax('GET', '/ui/views/tabs')
  }

  /**
   * Shared htmx.ajax over the tabbar mount. Always resolves to a promise, so
   * `.then` prunes are safe even without htmx present.
   * @param {'GET'|'POST'} method
   * @param {string} url
   * @param {object} [extraOpts] — merged into the swap options
   * @returns {Promise<any>}
   */
  #ajax(method, url, extraOpts) {
    if (!window.htmx) return Promise.resolve()
    const opts = Object.assign({ target: '#htmx-tabbar', swap: 'innerHTML' }, extraOpts)
    return window.htmx.ajax(method, url, opts)
  }

  /**
   * Activates the document for a uuid, owning the editor lifecycle end-to-end.
   * The SINGLE place a previous editor is destroyed:
   *
   * - tab SWITCH: the previous editor is destroyed (its WS closes) BEFORE the new
   *   one is created. That ordering is load-bearing for the Go WS takeover guard.
   * - TEARDOWN (uuid ''): the active editor is destroyed and its tab closed.
   * - Same-uuid re-activation: the editor and its live socket are KEPT.
   *
   * @param {string} uuid — target document uuid, or '' to tear down
   * @param {object} [options] — passed to the Tab's editor factory; the provider
   *   and loader are the host's own
   * @returns {SieveTab|null} the activated Tab, or null after a teardown
   */
  activateDocument(uuid, options) {
    const prev = this.#activeTab
    if (prev && prev.uuid !== uuid) {
      if (prev.editor) {
    // The ONE place a tab's editor goes away: pull its scroll coordinate and flush
    // it BEFORE the SelectionModel holding it is destroyed.
        this.#persistScroll(prev)
        prev.editor.destroy()
        prev.detachEditor()
      }
      // The MOUNT goes with the editor: closing it closes the container's channel
      // and discards its follower model.
      prev.detachMount()
      if (!uuid) this.closeTab(prev.uuid)
    }
    if (!uuid) return null

    const tab = this.openTab(uuid)
    if (!tab.editor) {
    // Close-before-open on ONE uuid is the whole rule: two live claims on a
    // container's channel is a takeover, and the loser is a silently dead UI.
      tab.detachMount()
    // THE MOUNT SEQUENCE. The host resolves the container, opens its channel, and
    // hands the lens ONE dependency: the provider. Which provider depends on what
    // the container IS, and that decision lives in the MountBinding.
      const kind = uuid.startsWith('prompt:') ? 'prompt' : 'note'
      const mount = new MountBinding(uuid, this.#documentService, this.#feed, kind)
    // Transport routing, NOT a repaint path: content reaches the lens through its
    // subscription, and what is left is nobody's document truth.
      if (kind !== 'prompt') mount.openChannel({ onMessage: (msg) => this.routeServerMessage(msg) })
      tab.attachMount(mount)
      tab.attachEditor(tab.createEditor(uuid, Object.assign({
        provider: mount.provider,
        loadContainer: () => mount.load(),
        mentionService: this.#mentionService,
        macroCatalog: this.#macroCatalog,
      }, options)))
    }
    return tab
  }

  /** The live editor for the active tab, or null. Call sites speak the editor's
   *  DOMAIN methods; a disconnected editor no-ops transport-backed ops safely.
   *  @returns {import('../lens/abstract-editor.js').AbstractEditor|null} */
  get activeEditor() {
    return this.#activeTab ? this.#activeTab.editor : null
  }

  /** Every lens this host has mounted right now — the active tab's, and the
   *  panel's draft. A host with two instruments on the page has two, and a
   *  gesture belongs to exactly one of them.
   *  @returns {Array<any>} */
  #mountedLenses() {
    return [this.activeEditor, this.#askPanel?.composer?.editor || null]
  }

  /** The mounted lens whose fixture contains `target`, or null outside them all.
   *  WHICH mount a gesture happened in is a fact about the GESTURE: a lens
   *  publishes the element it was mounted in, so nothing here names a mount and
   *  a second arrangement needs no second listener.
   *  @param {any} target the event target
   *  @returns {any|null} */
  #lensAt(target) {
    if (!target || typeof target.closest !== 'function') return null
    for (const lens of this.#mountedLenses()) {
      if (lens && lens.isMounted && lens.host && lens.host.contains(target)) return lens
    }
    return null
  }

  /**
   * Public entry point called from index.html. Opens/activates the shell Tab and
   * its editor, loads the body, and presents the surface. Falsy mountEl/uuid tears
   * the active editor down.
   * @param {HTMLElement|null} mountEl
   * @param {string} uuid
   * @param {string} [mode]
   */
  initEditor(mountEl, uuid, mode) {
    // Flush the previous editor while it is still attached, so its edits go out on
    // ITS socket before any teardown.
    const prev = this.activeEditor
    if (prev && prev.surface) this.flushSave()
    // initEditor never destroys editors directly: that is activateDocument's, and
    // the previous surface is unmounted by presentSurface or editor.destroy().

    if (!mountEl || !uuid) {
      // Teardown — #syncShell('') destroys the active editor and closes its tab.
      this.#syncShell('')
      this.#currentUuid = ''
      return
    }

    // Set the staleness guard SYNCHRONOUSLY before the fetch: the load's `.then`
    // re-checks it, so a later init supersedes this load.
    this.#currentUuid = uuid
    this.#syncShell(uuid)
    this.#currentMountEl = mountEl
    const wantMode = mode || this.#activeTab?.mode || 'wysiwyg'

    // The LOAD is a host act: it seeds the container's follower model and answers
    // with the facts only the host acts on. The lens is handed none of it; it
    // paints from the model on its subscription's bootstrap cue.
    const tab = this.#activeTab
    const mount = tab ? tab.mount : null
    if (!mount) return
    mount.load()
      .then((data) => {
        if (this.#currentUuid !== uuid) return // a later init superseded this load

        const isMarkdown = wantMode === 'markdown' || data.meta.mode === 'markdown' || uuid.startsWith('prompt:')

        const ed = this.activeEditor
        if (!ed) return
        // The editor's saved-fact baseline is the version this load served, and a
        // save can land the moment it mounts.
        ed.seedVersion(data.version)
        // presentSurface unmounts any previous surface, then subscribes — and the
        // subscription's first cue is what paints.
        ed.presentSurface(isMarkdown ? 'markdown' : 'wysiwyg', mountEl, isMarkdown ? (data.body || '') : null)
        // mode-changed fires only on an actual flip, not on the initial mount.
        if (this.#activeTab) this.#activeTab.recordMode(ed.mode)
        document.body.classList.toggle('markdown-mode', ed.mode === 'markdown')
        // 0 for a never-seen tab is the park-at-top floor, so one call serves both.
        ed.restoreScroll(data.scroll || 0)
      })
      .catch((err) => { console.error('[editor] load failed', err) })
  }

  /**
   * Syncs the shell to a tab-lifecycle transition, and ONLY when a NEW editor
   * instance was created subscribes its mode-event reaction.
   * ATTACH-ONCE-PER-EDITOR-INSTANCE: a same-uuid re-init reuses the existing
   * editor and must NOT re-subscribe, or mode-changed would double-fire.
   * @param {string} uuid — target uuid, or '' to tear down
   */
  #syncShell(uuid) {
    const existing = this.getTab(uuid)
    const hadEditor = !!(existing && existing.editor)
    const tab = this.activateDocument(uuid)
    if (tab && tab.editor && !hadEditor) {
      tab.editor.onEvent(this.onEditorModeEvent.bind(this))
      // The lazy crash-safety flush, on top of the guaranteed one in
      // activateDocument. scroll-changed never fires the meaningful
      // selection-update broadcast, so this is a SEPARATE listener.
      tab.editor.onEvent((e) => { if (e.type === 'scroll-changed') this.#scheduleScrollPersist(tab) })
    }
  }

  /** Handles the WS messages that are neither protocol, surface ops, nor awaited
   *  mode replies: only surfaces a server error.
   *  @param {{type?: string, message?: string}} msg */
  routeServerMessage(msg) {
    if (msg.type === 'error') {
      window.alert(msg.message || 'An error occurred.')
    }
  }

  /** The two non-toolbar chrome reactions to a surface mode flip: the body
   *  `markdown-mode` class plus the tab-strip re-render, and the failure alert.
   *  @param {{type: string, mode?: string, error?: unknown}} event */
  onEditorModeEvent(event) {
    if (event.type === 'mode-changed') {
      document.body.classList.toggle('markdown-mode', this.activeEditor?.mode === 'markdown')
      this.loadTabs()
    } else if (event.type === 'mode-change-failed') {
      console.error('[editor] mode toggle failed; staying in ' + event.mode, event.error)
      window.alert('Mode switch failed — staying in ' + event.mode + ' mode.')
    }
  }

  /** @returns {Promise<any>} */
  flushSave() {
    return this.activeEditor ? this.activeEditor.flushSave() : Promise.resolve()
  }

  /** Saves and resolves once the save has LANDED — for a caller whose next step
   *  reads the document from disk over another wire. @returns {Promise<void>} */
  saveAndSettle() {
    return this.activeEditor ? this.activeEditor.saveAndSettle() : Promise.resolve()
  }

  /** Registers the app-level editor DOM listeners. Called once at module load. */
  bootEditorLifecycle() {
    // The backend emits BOTH prompts:changed and notes:changed on a prompt revert,
    // and regular notes are left alone while typing, so both listeners guard on
    // the `prompt:` uuid prefix.
    document.addEventListener('prompts:changed', () => {
      if (this.#currentUuid?.startsWith('prompt:')) {
        this.initEditor(this.#currentMountEl, this.#currentUuid, this.activeEditor?.mode)
      }
    })
    document.addEventListener('notes:changed', () => {
      if (this.#currentUuid?.startsWith('prompt:')) {
        this.initEditor(this.#currentMountEl, this.#currentUuid, this.activeEditor?.mode)
      }
    })

    // RECONCILIATION, not an operation: the server broadcasts that a container is
    // already gone, and everything this workspace still holds for it goes too.
    // Deleting a BACKGROUND note reaches no element the delete's own response
    // swaps, which is why the news arrives on the workspace wire.
    //
    // Tearing down a MOUNTED editor here is the ORDINARY path, and it is safe:
    // destroy() performs exactly the unmount and channel-close activateDocument
    // performs on a switch. It deliberately does NOT flush the scroll coordinate —
    // there is no document left to restore it into. Either order is idempotent.
    document.addEventListener('sieve:container-deleted', (e) => {
      const uuid = /** @type {CustomEvent} */ (e).detail?.uuid
      if (!uuid) return
      const tab = this.getTab(uuid)
      if (!tab) return
      if (tab.editor) {
        tab.editor.destroy()
        tab.detachEditor()
      }
      tab.detachMount()
      this.closeTab(uuid)
    })

    // Capture phase is load-bearing: it must win before link handlers.
    document.addEventListener('click', (e) => {
      if (window.isMod(e)) {
        const a = e.target.closest ? e.target.closest('a') : null
        if (a && a.href && a.href.match(/^https?:\/\//)) {
          e.preventDefault()
          e.stopPropagation()
          if (window.runtime && window.runtime.BrowserOpenURL) {
            window.runtime.BrowserOpenURL(a.href)
          } else {
            window.open(a.href, '_blank')
          }
        }
      }
    }, true)

    // A restore is a genuine whole-container LOAD: reload() reseeds the model —
    // never a flat setContent re-parse, which re-mints ids.
    document.body.addEventListener('editor:restore', (e) => {
      const data = e.detail
      if (!data || !data.uuid) return
      this.activeEditor?.reload()
    })

    // Suppress the native context menu inside ANY mounted lens (capture).
    document.addEventListener('contextmenu', (e) => {
      if (this.#lensAt(e.target)) e.preventDefault()
    }, true)

    // Editor context menu: in a mounted lens, not on a sieve block. The two
    // listeners are the two PHASES — suppress before anything else sees the
    // gesture, offer after a block's own handler has had its refusal (it stops
    // propagation) — and both resolve the same way.
    document.addEventListener('contextmenu', (e) => {
      const ed = this.#lensAt(e.target)
      if (!ed) return
      if (e.target.closest('.ai-block, .image-block, .web-clip-block, .sieve-block')) return
      // No link is scraped off the DOM: the menu resolves it from the DOCUMENT,
      // the only view carrying the mark's range for the Convert offers.
      document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
        detail: { x: e.clientX, y: e.clientY, context: { type: 'editor', editor: ed.editorPane } }
      }))
    })

    // Fires only when the hovered block changes.
    document.addEventListener('mouseover', (e) => {
      const inMount = e.target.closest && e.target.closest('#tiptap-mount')
      const el = inMount ? e.target.closest('[data-id]') : null
      const key = el ? (el.getAttribute('data-kind') || 'prose') + '·' + el.getAttribute('data-id') : null
      if (key === this.#lastHoverKey) return
      this.#lastHoverKey = key
      document.dispatchEvent(new CustomEvent('editor:blockhover', {
        detail: el ? { id: el.getAttribute('data-id'), kind: el.getAttribute('data-kind') || 'prose' } : null
      }))
    })
  }

  // Each delegates DIRECTLY to a Workspace-owned child or to the active tab's
  // MOUNT. These public verbs ARE the component API the native menu calls.

  toggleSearch() { this.#searchOverlay?.toggle() }

  searchNext() { this.#searchOverlay?.next() }

  searchPrev() { this.#searchOverlay?.prev() }

  /** @param {string} [url] optional href prefill */
  openWebClipDialog(url) { this.#insertDialogs?.openWebClip(url) }

  /** @param {string} [url] optional href prefill */
  openUrlCardDialog(url) { this.#insertDialogs?.openUrlCard(url) }

  /**
   * Copies the active container's clean markdown export to the clipboard. A HOST
   * verb, not a lens one: the filtering the export applies is Go's, not any lens's
   * projection. The flush first is what includes what the user just typed.
   *
   * A native menu click carries no DOM gesture and steals focus, so WebKit rejects
   * navigator.clipboard — the Wails pasteboard is primary, the browser API is the
   * non-Wails dev fallback.
   * @returns {Promise<void>}
   */
  copyDocumentAsMarkdown() {
    const mount = this.#activeTab ? this.#activeTab.mount : null
    if (!mount) return Promise.resolve()
    return this.flushSave()
      .then(() => mount.exportAs('markdown'))
      .then((md) => {
        if (md == null) return
        const rt = /** @type {any} */ (window).runtime
        if (rt && rt.ClipboardSetText) return rt.ClipboardSetText(md)
        return navigator.clipboard.writeText(md)
      })
      .catch((err) => { console.warn('export-markdown copy failed', err) })
  }

  /**
   * The toolbar's file-attach path. It lives here because the picker's dialog
   * blurs the editor — the ANCHOR was captured before it opened and comes back in.
   * @param {{mimeType: string, content: string, filename: string}} file
   * @param {string|null|undefined} afterBlockId
   * @returns {Promise<unknown>}
   */
  attachFile(file, afterBlockId) {
    const mount = this.#activeTab ? this.#activeTab.mount : null
    const provider = mount ? /** @type {any} */ (mount.provider) : null
    if (!provider || typeof provider.paste !== 'function') return Promise.resolve()
    // context.filename is what says "this came from a FILE" rather than "this is
    // pasted text": without it a picked .yml is claimed by nobody.
    return provider.paste({
      kind: 'smart',
      entries: [{ mimeType: file.mimeType, content: file.content, context: { filename: file.filename } }],
    }, afterBlockId)
  }

  /** @param {(tab: SieveTab|null) => void} fn @returns {() => void} unsubscribe */
  onActiveTabChanged(fn) {
    this.#activeTabListeners.push(fn)
    return () => {
      this.#activeTabListeners = this.#activeTabListeners.filter(l => l !== fn)
    }
  }

  /**
   * Register a listener for the ACTIVE tab's selection stream. On an active-tab
   * change the previous subscription is dropped and the new tab's taken up, with
   * an immediate republish; an active-to-null teardown emits a null context.
   * @param {(ctx: import('../lens/document-editor/selection-model.js').SelectionContext|null) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => {
      this.#selectionListeners = this.#selectionListeners.filter(l => l !== fn)
    }
  }

  /** @returns {import('../lens/document-editor/selection-model.js').SelectionContext|null} */
  getSelectionContext() {
    return this.#activeTab && this.#activeTab.editor
      ? this.#activeTab.editor.getSelectionContext()
      : null
  }

  /** Restore focus/selection on the active tab — a VERB on the Workspace, never on
   *  the frozen context. Safe no-op when nothing is open.
   *  @param {import('../lens/document-editor/selection-model.js').SelectionContext|null} ctx */
  setPosition(ctx) {
    if (ctx && this.#activeTab && this.#activeTab.editor) {
      this.#activeTab.editor.applyPosition(ctx)
    }
  }

  /** @param {SieveTab|null} tab */
  #setActiveTab(tab) {
    if (this.#activeTab === tab) return
    this.#activeTab = tab
    this.#switchSelectionSource(tab)
    this.#notifyActiveTabListeners()
  }

  /**
   * Re-points the republished selection stream at the new active tab and
   * synthesizes an immediate republish, because a tab change IS a selection
   * change. Null-guarded: when the new tab has no editor yet, nothing is
   * synthesized and the tab's own forward delivers the first context.
   * @param {SieveTab|null} tab
   */
  #switchSelectionSource(tab) {
    if (this.#unsubActiveSelection) { this.#unsubActiveSelection(); this.#unsubActiveSelection = null }
    if (!tab) { this.#notifySelectionListeners(null); return }
    this.#unsubActiveSelection = tab.onSelectionUpdate((ctx) => this.#notifySelectionListeners(ctx))
    // The synth pulls from the MOUNT — the host end of the presence seam, which
    // holds the last advert the lens made.
    const synth = tab.getSelectionContext()
    if (synth) this.#notifySelectionListeners(synth)
  }

  #notifyActiveTabListeners() {
    const tab = this.#activeTab
    for (const fn of this.#activeTabListeners) {
      try { fn(tab) } catch (e) { console.error('[SieveWorkspace] activeTabChanged listener threw', e) }
    }
  }

  /** @param {import('../lens/document-editor/selection-model.js').SelectionContext|null} ctx */
  #notifySelectionListeners(ctx) {
    for (const fn of this.#selectionListeners) {
      try { fn(ctx) } catch (e) { console.error('[SieveWorkspace] selectionUpdate listener threw', e) }
    }
  }

  /** Debounces a lazy scroll-persist for the ACTIVE tab. One timer suffices: only
   *  the active tab has a live editor to report scroll-changed from.
   *  @param {SieveTab} tab */
  #scheduleScrollPersist(tab) {
    if (this.#scrollPersistTimer) clearTimeout(this.#scrollPersistTimer)
    this.#scrollPersistTimer = setTimeout(() => {
      this.#scrollPersistTimer = null
      this.#persistScroll(tab)
    }, 3000)
  }

  /** Pulls a tab's scroll coordinate — a PULL, never a push — and persists it over
   *  the workspace channel. Fire-and-forget: scroll is caret-class state.
   *  @param {SieveTab} tab */
  #persistScroll(tab) {
    if (this.#scrollPersistTimer) { clearTimeout(this.#scrollPersistTimer); this.#scrollPersistTimer = null }
    const ctx = tab.editor ? tab.editor.getSelectionContext() : null
    if (!ctx || ctx.scroll == null) return
    this.#workspaceService.persistScroll(tab.uuid, ctx.scroll)
  }

  /** @type {AskPanel|null} the permanent Ask-panel child (constructed once) */
  #askPanel = null

  /** @type {InsertDialogs|null} the URL insert dialogs child */
  #insertDialogs = null

  /** @type {SearchOverlay|null} the document search overlay child */
  #searchOverlay = null

  /** @type {CommandBadges|null} the command badges child */
  #commandBadges = null

  /** @type {StatusBar|null} the status-bar child (stats/dirty/blockid slots) */
  #statusBar = null

  /** @type {SidebarView|null} keeps the sidebar's tree/search mode across invalidations */
  #sidebarView = null

  /** Constructs the Workspace-owned chrome children, once at module load. Each
   *  null-guards its structural DOM, so a headless import leaves writes no-ops. */
  bootChrome() {
    if (!this.#commandBadges) this.#commandBadges = new CommandBadges()
    if (!this.#askPanel) this.#askPanel = new AskPanel(this, this.#commandService, this.#commandBadges, this.#mentionService)
    if (!this.#insertDialogs) this.#insertDialogs = new InsertDialogs(this)
    if (!this.#searchOverlay) this.#searchOverlay = new SearchOverlay(this)
    if (!this.#statusBar) this.#statusBar = new StatusBar(this)
    if (!this.#sidebarView) this.#sidebarView = new SidebarView().attach()
  }

  /**
   * Dials the workspace channel, the page's ONLY way to hear the server speak.
   * It must be dialled EXPLICITLY at boot, because WorkspaceService.open() is
   * otherwise reached only from send() — so a page where nobody runs a command
   * would hear nothing at all, with no error to explain it.
   *
   * Called after every tenant is registered, because the server speaks first: the
   * jobs snapshot is written the instant the socket connects, and a tenant
   * registering after that would have it dropped as unclaimed.
   */
  bootPushChannel() {
    this.#workspaceService.open()
  }

  /** @returns {CommandBadges|null} */
  get commandBadges() { return this.#commandBadges }

  /** @returns {AskPanel|null} the permanent Ask-panel child */
  get askPanel() { return this.#askPanel }

  /** @returns {InsertDialogs|null} the URL insert dialogs child */
  get insertDialogs() { return this.#insertDialogs }

  /** @returns {SearchOverlay|null} the document search overlay child */
  get searchOverlay() { return this.#searchOverlay }

  /**
   * Boots the tab strip and subscribes to the refresh signals every other panel
   * declares as an hx-trigger; the Workspace OWNS the tabbar render, so its mount
   * has no attributes of its own to carry them.
   *
   * TWO SIGNALS, ONE SUBJECT: the invalidation push (reaching every client) and
   * the HX-Trigger response event (reaching only the client that made the
   * request). Both are listened for because they answer different questions, and
   * a duplicate refetch is cheaper than a strip that lags its own click.
   */
  startTabbar() {
    const boot = () => { if (document.getElementById('htmx-tabbar')) this.loadTabs() }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
    } else {
      boot()
    }
    const refresh = () => this.loadTabs()
    document.addEventListener('sieve:invalidate-session', refresh)
    document.addEventListener('sieve:invalidate-notes', refresh)
    document.addEventListener('session:changed', refresh)
    document.addEventListener('notes:changed', refresh)
  }
}

const workspace = new SieveWorkspace()
window.sieveWorkspace = workspace

// The push channel is dialled LAST: its first frame arrives the moment the socket
// connects, and its consumers are the DOM listeners the boots above install.
// Dialling first would publish into a page where nothing is listening yet.
if (typeof document !== 'undefined') {
  workspace.startTabbar(); workspace.bootChrome(); workspace.bootEditorLifecycle()
  if (typeof WebSocket === 'function') workspace.bootPushChannel()
}
