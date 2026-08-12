// @ts-check
// workspace.js — Workspace singleton (P1: zero-behavior skeleton).
// Workspace is the root of the JS component model. It holds the open Tabs,
// tracks the active Tab, and owns an empty listener registry (listeners wired
// in later phases). It is created once at boot (below) and exposed on window
// as `window.sieveWorkspace` so the browser console can reach it and so
// editor.js (a classic script sharing the same global) can look it up.
// Dual-use ES module (block-position.js pattern): `export` for vitest imports,
// window.* assignment for classic-script access. Loaded in index.html with
// type="module" — a plain <script> tag would fail at parse on `export`.
// Modules execute deferred (after classic scripts parse); editor.js only reads
// window.sieveWorkspace at runtime (initEditor via htmx events), never at parse.

import { SieveTab } from './tab.js'
import { BlockService } from '../block/block-service.js'
import { DocumentService } from '../block/document-service.js'
import { WorkspaceService } from '../block/workspace-service.js'
import { CommandService } from '../block/command-service.js'
import { MentionService } from '../block/mention-service.js'
import { CommandBadges } from './command-badges.js'
import { AskPanel } from './ask-panel.js'
import { InsertDialogs } from './insert-dialogs.js'
import { SearchOverlay } from './search-overlay.js'
import { StatusBar } from './status-bar.js'

export class SieveWorkspace {
  /** @type {Map<string, SieveTab>} uuid → Tab */
  #tabs = new Map()

  /** @type {SieveTab|null} */
  #activeTab = null

  // ── Listener registry (empty in P1; typed registration methods wired in P2) ──

  /** @type {Array<(tab: SieveTab|null) => void>} */
  #activeTabListeners = []

  /**
   * Public selection-update registry (P3.B). Mirrors #activeTabListeners: it
   * republishes the ACTIVE tab's selection stream only (a background tab's push
   * never reaches here). Consumers arrive in P3.D (the Ask panel); today it has
   * no production consumer.
   * @type {Array<(ctx: import('../editor/selection-model.js').SelectionContext|null) => void>}
   */
  #selectionListeners = []

  /** @type {(() => void)|null} unsubscribe from the ACTIVE tab's onSelectionUpdate */
  #unsubActiveSelection = null

  // ── Editor lifecycle state (P4.F — moved from editor.js) ─────────────────────

  /** @type {string} the active editor's uuid ('' when torn down). Load-bearing
   * staleness guard: initEditor sets this synchronously before the async load and
   * the load's `.then` re-checks it so a later init supersedes an in-flight load. */
  #currentUuid = ''

  /** @type {HTMLElement|null} the active editor's mount element. QUIRK PRESERVED
   * (do NOT "fix"): this is NOT cleared on teardown, matching editor.js. */
  #currentMountEl = null

  /** @type {string|null} last hovered block key — dedup for editor:blockhover. */
  #lastHoverKey = null

  /** @type {ReturnType<typeof setTimeout>|null} issue #51 lazy scroll-persist debounce (the active tab only — a background tab has no live editor to report from) */
  #scrollPersistTimer = null

  /** @type {BlockService} the app-wide protocol boundary singleton AND wire
   * owner (contract §service pair; issue #49 Phase 1) — constructed HERE, the
   * composition root, and handed down through editor options → surface →
   * pane. Never window.*. */
  #blockService

  /** @type {DocumentService} the uuid-addressed half, composed over the wire
   * owner by constructor injection (contract §service pair). */
  #documentService

  /** @type {WorkspaceService} the session-channel wire owner — the workspace
   * command plane's transport, shared by every tenant that speaks it (#74 P1).
   * Sibling of #blockService, which owns the per-uuid document channels. */
  #workspaceService

  /** @type {CommandService} the workspace command plane's slash-command tenant. */
  #commandService

  /** @type {MentionService} the plane's `@`-picker tenant (#74 P4) — the second
   * tenant of the session socket and the first non-command one. */
  #mentionService

  /**
   * @param {import('../block/block-service.js').BlockServiceOptions} [serviceOptions]
   *   — the BlockService test seams (socketFactory / wsUrlFor). EMPTY in prod:
   *   the boot singleton below constructs with real sockets; tests inject
   *   fakes here (the seam moved off the editors onto the wire owner).
   */
  constructor(serviceOptions) {
    this.#blockService = new BlockService(serviceOptions)
    this.#documentService = new DocumentService(this.#blockService)
    this.#workspaceService = new WorkspaceService({ socketFactory: serviceOptions?.socketFactory })
    this.#commandService = new CommandService(this.#workspaceService, {
      commands: typeof window !== 'undefined' ? /** @type {any} */ (window).__sieveCommands || [] : [],
    })
    this.#mentionService = new MentionService(this.#workspaceService)
  }

  /** The BlockService singleton (handed down; renderers/adapters consume it). */
  get blockService() { return this.#blockService }

  /** The DocumentService singleton (editors/Workspace consume it). */
  get documentService() { return this.#documentService }

  /** The WorkspaceService singleton (session-channel wire owner; tenants
   *  register on it — the plane, not a feature). */
  get workspaceService() { return this.#workspaceService }

  /** The CommandService singleton (workspace slash-command protocol peer). */
  get commandService() { return this.#commandService }

  /** The MentionService singleton (the `@` picker's protocol peer). */
  get mentionService() { return this.#mentionService }

  // ── Tab management ────────────────────────────────────────────────────────────

  /**
   * Returns the Tab for a uuid if it exists, otherwise null.
   * @param {string} uuid
   * @returns {SieveTab|null}
   */
  getTab(uuid) {
    return this.#tabs.get(uuid) ?? null
  }

  /**
   * Opens (creates) a Tab for the given uuid if not already tracked, marks it
   * active, and returns it. Called by editor.js at the start of initEditor.
   * @param {string} uuid
   * @returns {SieveTab}
   */
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

  /**
   * Closes (removes) the Tab for a uuid if it is tracked. If it was the active
   * tab, activeTab becomes null. Called by editor.js when the editor tears down.
   * @param {string} uuid
   */
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

  /**
   * Currently active Tab, or null when no document is open.
   * @returns {SieveTab|null}
   */
  get activeTab() { return this.#activeTab }

  // ── Tab-lifecycle verbs (P2.D — the external API facade) ─────────────────────
  // These are the ONLY front-end entry points for tab mutation and the tabbar
  // render. Each is a thin owner over the SAME htmx.ajax call the templates ran
  // before P2.D (identical swap semantics; the OOB editor mount is preserved).
  // The INTERNALS still drive the server-rendered HTMX templates (tabbar.html +
  // OOB editor.html); the self-rendering-JSON version is deferred to tech-debt
  // V-B. Each guards htmx (mirrors the templates' `window.htmx && …`) and returns
  // the htmx.ajax promise. See docs/design/specs/2026-07-08-workspace-editor-
  // component-model.md.

  /**
   * Opens (or focuses) the document for a uuid: POST /api/note/open/{uuid},
   * swapping the tabbar. The server re-renders the strip and OOB-mounts the
   * editor; the OOB re-init drives activateDocument, so no client prune here.
   * @param {string} uuid
   * @returns {Promise<any>}
   */
  open(uuid) {
    // RAW id in the path (no encodeURIComponent): chi.URLParam does not unescape,
    // and the Go handlers compare against decoded ids (strings.HasPrefix(id,
    // "prompt:")). A `prompt:` uuid must arrive with a literal colon — a legal
    // path char — exactly as the pre-P2.D templates sent `{{.ID}}`. Percent-
    // encoding the colon made prompt opens 404. All ids are URL-path-safe.
    return this.#ajax('POST', '/api/note/open/' + uuid)
  }

  /**
   * Creates a new untitled note and opens it: POST /api/note/new, tabbar swap.
   * @returns {Promise<any>}
   */
  newNote() {
    return this.#ajax('POST', '/api/note/new')
  }

  /**
   * Closes one tab (the ✕ button, context-menu "Close Tab"). A single-element
   * call into the one close mechanism.
   * @param {string} uuid
   * @returns {Promise<any>}
   */
  close(uuid) { return this.#closeTabs([uuid]) }

  /**
   * Closes the currently active tab, or no-ops when nothing is active. Replaces
   * the native menu's `data-uuid` DOM scrape.
   * @returns {Promise<any>|void}
   */
  closeActiveTab() {
    if (this.#activeTab) return this.close(this.#activeTab.uuid)
  }

  /**
   * The authoritative list of ALL open tab ids — read from the rendered strip
   * (#tabs-area [data-tab-id]), NOT #tabs. #tabs holds only tabs ACTIVATED in this
   * JS session (each has a live SieveTab/editor); a tab loaded from the session but
   * never clicked has no #tabs entry. The server session (the strip) is the source
   * of truth for what is open, so close-all / close-others enumerate from it.
   * @returns {string[]}
   */
  #openTabIds() {
    return Array.from(document.querySelectorAll('#tabs-area [data-tab-id]'))
      .map((el) => /** @type {HTMLElement} */ (el).dataset.tabId)
      .filter((id) => !!id)
  }

  /**
   * Closes every open tab (context-menu "Close All Tabs"). The server empties the
   * session and mints one fresh note; the funnel prunes the old identities.
   * @returns {Promise<any>}
   */
  closeAll() { return this.#closeTabs(this.#openTabIds()) }

  /**
   * Closes every tab EXCEPT keepUuid (context-menu "Close Others"). Same funnel,
   * complement id set over the rendered strip. Close-to-right / close-to-left are
   * the same shape over a tab-order slice.
   * @param {string} keepUuid
   * @returns {Promise<any>}
   */
  closeOthers(keepUuid) {
    return this.#closeTabs(this.#openTabIds().filter((u) => u !== keepUuid))
  }

  /**
   * The ONE close path: POST the id SET to /api/tabs/close as JSON {ids}. The
   * server owns which tabs close, the active-tab re-point, the Smart-Close AI
   * filing per doc, and the empty⇒fresh-note; it renders tabbar.html + OOB
   * editor.html. We apply that with htmx.swap (fetch, not htmx.ajax, so the body
   * can be JSON) and prune the closed identities in afterSettleCallback — i.e.
   * AFTER the OOB editor mount's initEditor→activateDocument has destroyed the
   * outgoing editor (its WS) while #activeTab still pointed at it. Pruning earlier
   * would null #activeTab first and leak that editor.
   * @param {string[]} uuids
   * @returns {Promise<any>}
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
   * Reorders the tab strip: POST /api/tabs/reorder with from/to indices, tabbar
   * swap.
   * @param {number} fromIdx — source tab index
   * @param {number} toPos — target insertion position
   * @returns {Promise<any>}
   */
  reorder(fromIdx, toPos) {
    return this.#ajax('POST', '/api/tabs/reorder', { values: { from: fromIdx, to: toPos } })
  }

  /**
   * Fetches and renders the tab strip: GET /api/tabs, tabbar swap. The boot +
   * SSE refetch entry point (P2.D relocated this off the #htmx-tabbar div's
   * hx-get/hx-trigger).
   * @returns {Promise<any>}
   */
  loadTabs() {
    return this.#ajax('GET', '/api/tabs')
  }

  /**
   * Shared htmx.ajax over the tabbar mount. Guards htmx (mirrors the templates)
   * and always resolves to a promise so `.then` prunes are safe even without
   * htmx present (tests, early boot).
   * @param {'GET'|'POST'} method
   * @param {string} url
   * @param {object} [extraOpts] — merged into the swap options (e.g. values)
   * @returns {Promise<any>}
   */
  #ajax(method, url, extraOpts) {
    if (!window.htmx) return Promise.resolve()
    const opts = Object.assign({ target: '#htmx-tabbar', swap: 'innerHTML' }, extraOpts)
    return window.htmx.ajax(method, url, opts)
  }

  // ── Editor lifecycle (P2.A fix wave: the ONE authoritative teardown path) ────

  /**
   * Activates the document for a uuid, owning the editor lifecycle end-to-end.
   * This is the SINGLE place a previous editor is destroyed:
   *
   * - Genuine tab SWITCH (uuid differs from the active tab's): the previous
   *   editor is destroyed (its WS closes) BEFORE the new tab's editor is
   *   created (its WS opens). That close-before-open ordering is load-bearing
   *   for the Go WS takeover guard (ws_handler.go pointer-identity unregister)
   *   and matches the old openEditorWs behavior (closeEditorWs() first).
   * - TEARDOWN (uuid ''): the active editor is destroyed and its tab closed.
   * - Same-uuid re-activation (toggleMode, a prompt re-init, and any editor.html
   *   re-render for the unchanged active note — e.g. re-opening the active note
   *   from the sidebar, or closing a background tab): the editor instance and
   *   its live socket are KEPT — destroy is never spurious. (Behavior delta vs
   *   the pre-P2.A code, which recycled the socket on those note paths; keeping
   *   it avoids the takeover race entirely.)
   *
   * @param {string} uuid — target document uuid, or '' to tear down
   * @param {object} [options] — passed to the Tab's editor factory
   *   (surfaceCollaborators, onServerMessage, …)
   * @returns {SieveTab|null} the activated Tab, or null after a teardown
   */
  activateDocument(uuid, options) {
    const prev = this.#activeTab
    if (prev && prev.uuid !== uuid) {
      if (prev.editor) {
        // issue #51: the ONE place a tab's editor goes away (switch OR
        // teardown) — pull its scroll coordinate and flush it to session.json
        // BEFORE the SelectionModel that holds it is destroyed. The lazy
        // debounce (see #syncShell) covers the crash-loss window; this call is
        // the guaranteed flush for the ordinary switch/close path.
        this.#persistScroll(prev)
        prev.editor.destroy()
        prev.detachEditor()
      }
      if (!uuid) this.closeTab(prev.uuid)
    }
    if (!uuid) return null

    const tab = this.openTab(uuid)
    if (!tab.editor) {
      // The service pair rides the editor options; a connect-declaring editor
      // (NoteEditor) opens its channel through documentService at construction,
      // registering itself as the channel delegate — no separate per-document
      // handle registration remains (the v1 seam is retired).
      tab.attachEditor(tab.createEditor(uuid, Object.assign({ documentService: this.#documentService }, options)))
    }
    return tab
  }

  // ── Editor boot/lifecycle (P4.F — moved from editor.js's IIFE) ────────────────
  // The BOOT/LIFECYCLE half of the retired editor.js island now lives on the
  // Workspace (the app-root singleton): the derived active-editor accessor, the
  // initEditor entry point (called from index.html), the mode/error/save
  // reactions, and the app-level DOM listeners (bootEditorLifecycle). Pass 2
  // retired the residual window.* facades (_editorSave / _sieveCopyImageToClipboard
  // / __stashActiveTabUuid) pass 1 had kept — only window.sieveWorkspace survives.

  /**
   * The live editor instance for the active tab (a NoteEditor or PromptEditor),
   * or null. Call sites speak the editor's DOMAIN methods (createBlock /
   * flushSave / …); a disconnected editor (PromptEditor) no-ops the
   * transport-backed ops safely, so nothing here probes for it. (Replaces
   * editor.js's `_activeEditor()`.)
   * @returns {import('../editor/abstract-editor.js').AbstractEditor|null}
   */
  get activeEditor() {
    return this.#activeTab ? this.#activeTab.editor : null
  }

  /**
   * Public entry point called from index.html (DOMContentLoaded / htmx:load /
   * library switch). Opens/activates the shell Tab + its editor for `uuid`, loads
   * the document body from the backend, and presents the surface. Falsy
   * mountEl/uuid tears the active editor down. (Moved verbatim-in-behaviour from
   * editor.js initEditor.)
   * @param {HTMLElement|null} mountEl
   * @param {string} uuid
   * @param {string} [mode]
   */
  initEditor(mountEl, uuid, mode) {
    // Flush the previous editor's pending edits while it is still attached, so
    // they go out on ITS socket before any teardown (surface flush + WS flush).
    const prev = this.activeEditor
    if (prev && prev.surface) this.flushSave()
    // initEditor never destroys editors/surfaces directly: the shell editor is
    // destroyed only in activateDocument (via #syncShell); the previous surface is
    // unmounted by presentSurface (same-uuid re-init) or editor.destroy() (switch).

    if (!mountEl || !uuid) {
      // Teardown — #syncShell('') destroys the active editor and closes its tab.
      this.#syncShell('')
      this.#currentUuid = ''
      return
    }

    // Set the staleness guard SYNCHRONOUSLY before the fetch: the load's `.then`
    // re-checks `this.#currentUuid !== uuid` so a later init supersedes this load.
    this.#currentUuid = uuid
    this.#syncShell(uuid)
    this.#currentMountEl = mountEl
    const wantMode = mode || this.#activeTab?.mode || 'wysiwyg'

    // Document load rides the service boundary (contract §service pair): the
    // service owns the HTTP call, types the block list into envelopes, and seeds
    // the truth-mirror. The surface render pipeline consumes the envelopes; the
    // untyped `raw` wire bridge is retired (issue #49 Phase 3).
    this.#documentService.load(uuid)
      .then((data) => {
        if (this.#currentUuid !== uuid) return // a later init superseded this load
        window.SieveAI?.loadActiveJobs()

        const isMarkdown = wantMode === 'markdown' || data.meta.mode === 'markdown' || uuid.startsWith('prompt:')

        const ed = this.activeEditor
        if (!ed) return
        // The editor owns its root (#tiptap-mount); the surface owns the DOM under
        // it. presentSurface unmounts any previous surface first.
        ed.presentSurface(
          isMarkdown ? 'markdown' : 'wysiwyg',
          mountEl,
          isMarkdown ? (data.body || '') : { body: data.body || '', blocks: data.blocks }
        )
        // Seed the Tab's mode record + body class after the initial present
        // (mode-changed does not fire on initial mount — only on an actual flip).
        if (this.#activeTab) this.#activeTab.recordMode(ed.mode)
        document.body.classList.toggle('markdown-mode', ed.mode === 'markdown')
        // issue #51: restore the session's saved scroll (0 for a never-seen /
        // never-scrolled tab — the same value the park-at-top floor uses, so
        // one call serves both).
        ed.restoreScroll(data.scroll || 0)
      })
      .catch((err) => { console.error('[editor] load failed', err) })
  }

  /**
   * Syncs the shell to a tab-lifecycle transition (moved from editor.js
   * _syncShell): delegates to activateDocument — the ONE authoritative editor
   * teardown path — and, ONLY when a NEW editor instance was created
   * (`tab.editor && !hadEditor`), subscribes its mode-event reaction.
   * ATTACH-ONCE-PER-EDITOR-INSTANCE: a same-uuid re-init (toggleMode / prompt
   * revert) reuses the existing editor and must NOT re-subscribe, or mode-changed
   * would double-fire.
   * @param {string} uuid — target uuid, or '' to tear down
   */
  #syncShell(uuid) {
    const existing = this.getTab(uuid)
    const hadEditor = !!(existing && existing.editor)
    const tab = this.activateDocument(uuid, { onServerMessage: this.routeServerMessage.bind(this) })
    if (tab && tab.editor && !hadEditor) {
      tab.editor.onEvent(this.onEditorModeEvent.bind(this))
      // issue #51: the lazy crash-safety flush — a debounced persist on top of
      // the guaranteed one in activateDocument (switch/teardown), so a crash
      // mid-session loses at most a few seconds of scrolling, not the whole
      // session. scroll-changed never fires the meaningful selection-update
      // broadcast (SelectionModel excludes it); this is a SEPARATE listener on
      // the SAME editor event stream doc-changed/transaction already use.
      tab.editor.onEvent((e) => { if (e.type === 'scroll-changed') this.#scheduleScrollPersist(tab) })
    }
  }

  /**
   * Handles the WS messages that are neither protocol nor surface ops nor awaited
   * mode replies (moved from editor.js): only surfaces a server error. A late
   * fall-through (e.g. a stray mode reply) is deliberately dropped.
   * @param {{type?: string, message?: string}} msg
   */
  routeServerMessage(msg) {
    if (msg.type === 'error') {
      window.alert(msg.message || 'An error occurred.')
    }
  }

  /**
   * The two non-toolbar chrome reactions to a surface mode flip (moved from
   * editor.js onEditorModeEvent): the body `markdown-mode` class (drives the
   * ask-panel/table hide CSS) + the tab-strip re-render; and the verbatim
   * stay-on-failure alert. A newly created editor gets this as its mode reaction
   * (subscribed once in #syncShell).
   * @param {{type: string, mode?: string, error?: unknown}} event
   */
  onEditorModeEvent(event) {
    if (event.type === 'mode-changed') {
      document.body.classList.toggle('markdown-mode', this.activeEditor?.mode === 'markdown')
      this.loadTabs()
    } else if (event.type === 'mode-change-failed') {
      console.error('[editor] mode toggle failed; staying in ' + event.mode, event.error)
      window.alert('Mode switch failed — staying in ' + event.mode + ' mode.')
    }
  }

  /**
   * Flushes the active editor's pending edits (moved from editor.js flushSave).
   * NoteEditor: channel flush; PromptEditor: HTTP save override. Returns a
   * Promise so callers can await the save.
   * @returns {Promise<any>}
   */
  flushSave() {
    return this.activeEditor ? this.activeEditor.flushSave() : Promise.resolve()
  }

  /**
   * Registers the app-level editor DOM listeners (moved from editor.js's IIFE
   * body in P4.F). Called once at module load next to startTabbar()/bootChrome().
   * The listeners read the active editor via this.activeEditor. The residual
   * window.* facades (_editorSave / _sieveCopyImageToClipboard / P4.F pass 1)
   * were retired in pass 2 — callers now use window.sieveWorkspace.flushSave()
   * and the ui/copy-image.js util directly.
   */
  bootEditorLifecycle() {
    // External changes to a prompt (revert / background edit) → re-init in place.
    // The backend emits BOTH prompts:changed and notes:changed on a prompt revert;
    // regular notes are left alone while typing, so both listeners guard on the
    // prompt: uuid prefix. NOTE: startTabbar() ALSO listens for notes:changed (its
    // own tabbar refresh) — this is a SEPARATE, intentionally-additional listener.
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

    // Global capture for Ctrl/Cmd+Click on any link in the app → open externally
    // (capture-phase `true` PRESERVED — it must win before link handlers).
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

    // Restore renders the backend's RELOADED block list (ids intact) via
    // editor.softReload — never a flat setContent re-parse (which re-mints ids).
    document.body.addEventListener('editor:restore', (e) => {
      const data = e.detail
      if (!data || !data.uuid) return
      this.activeEditor?.softReload()
    })

    // Suppress the native context menu inside the editor mount (capture).
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest('#tiptap-mount')) e.preventDefault()
    }, true)

    // Editor context menu: in-mount, not on a sieve block, with an active editor.
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('#tiptap-mount')) return
      if (e.target.closest('.ai-block, .image-block, .web-clip-block, .sieve-block')) return
      const ed = this.activeEditor
      if (!ed) return
      // No link scraped off the DOM here: the menu resolves the link from the
      // DOCUMENT (ProseLink.forSelection over the snapped selection), which is the
      // only view that carries the mark's range for the Convert offers. The old
      // `linkUrl` detail existed solely to prefill the Insert dialogs, and those
      // no longer vary with it (#67).
      document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
        detail: { x: e.clientX, y: e.clientY, context: { type: 'editor', editor: ed.editorPane } }
      }))
    })

    // Block-ID hover readout (dev/debug) → editor:blockhover. Pure DOM read; both
    // prose and Sieve blocks carry data-id (Sieve also data-kind). Fires only when
    // the hovered block changes (#lastHoverKey dedup).
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

  // ── Chrome verbs (P4.D: the provideChrome registry is fully retired) ──────────
  // Every chrome verb now delegates DIRECTLY to a Workspace-owned child or the
  // active editor — no registry hop. The search overlay + insert dialogs are P4.C
  // children; copyDocumentAsMarkdown reaches the active editor's copyAsMarkdown
  // (P4.D — the editor owns the export). The public verbs ARE the component API
  // the native menu calls (main.go buildMenu); their external contract is unchanged.

  /** Shows/hides the document search overlay (P4.C child). */
  toggleSearch() { this.#searchOverlay?.toggle() }

  /** Advances to the next search match (F3 / Mod+G) — opens the overlay first if closed. */
  searchNext() { this.#searchOverlay?.next() }

  /** Advances to the previous search match (Shift+F3 / Mod+Shift+G) — opens the overlay first if closed. */
  searchPrev() { this.#searchOverlay?.prev() }

  /**
   * Opens the Insert from URL dialog — the web-clip entry point (P4.C child).
   * @param {string} [url] optional href prefill (no caller supplies one today:
   *   every entry point is a plain "insert something new")
   */
  openWebClipDialog(url) { this.#insertDialogs?.openWebClip(url) }

  /**
   * Opens the Insert Link Card dialog (P4.C child).
   * @param {string} [url] optional href prefill (see openWebClipDialog)
   */
  openUrlCardDialog(url) { this.#insertDialogs?.openUrlCard(url) }

  /** Copies the active document's clean markdown export to the clipboard (P4.D: editor-owned). */
  copyDocumentAsMarkdown() { this.#activeTab?.editor?.copyAsMarkdown() }

  // ── Listener registry (P1: registration methods exist, empty — wired P2) ─────

  /**
   * Register a listener called whenever the active tab changes (including to null).
   * Returns an unsubscribe function.
   * @param {(tab: SieveTab|null) => void} fn
   * @returns {() => void}
   */
  onActiveTabChanged(fn) {
    this.#activeTabListeners.push(fn)
    return () => {
      this.#activeTabListeners = this.#activeTabListeners.filter(l => l !== fn)
    }
  }

  /**
   * Register a listener for the ACTIVE tab's selection stream (P3.B). Returns an
   * unsubscribe. The Workspace republishes only the active tab's contexts; a
   * background tab's push is not delivered. On an active-tab change the previous
   * subscription is dropped and the new tab's is taken up, with an immediate
   * D4-synth republish from the new editor's current context (null-guarded); an
   * active→null teardown emits a null context so consumers can clear.
   * @param {(ctx: import('../editor/selection-model.js').SelectionContext|null) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => {
      this.#selectionListeners = this.#selectionListeners.filter(l => l !== fn)
    }
  }

  /**
   * Pull the active tab's current frozen SelectionContext, or null when no document
   * is open (P3.E — the read half of the read/write coordinate symmetry). Mirrors
   * the internal pull `#switchSelectionSource` already performs.
   * @returns {import('../editor/selection-model.js').SelectionContext|null}
   */
  getSelectionContext() {
    return this.#activeTab && this.#activeTab.editor
      ? this.#activeTab.editor.getSelectionContext()
      : null
  }

  /**
   * Restore focus/selection on the active tab from a (previously pulled) coordinate
   * (P3.E — the WRITE half; a VERB on the Workspace, never on the frozen context).
   * Routes straight to the active editor's applyPosition (Tab holds no position
   * write). Safe no-op when no document is open or ctx is null.
   * @param {import('../editor/selection-model.js').SelectionContext|null} ctx
   */
  setPosition(ctx) {
    if (ctx && this.#activeTab && this.#activeTab.editor) {
      this.#activeTab.editor.applyPosition(ctx)
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  /** @param {SieveTab|null} tab */
  #setActiveTab(tab) {
    if (this.#activeTab === tab) return
    this.#activeTab = tab
    this.#switchSelectionSource(tab)
    this.#notifyActiveTabListeners()
  }

  /**
   * Re-points the republished selection stream at the new active tab (P3.B):
   * drops the old tab's subscription, subscribes to the new one's
   * onSelectionUpdate, and synthesizes an immediate republish (D4 — a tab change
   * IS a selection change). The synth is null-guarded: when the new tab has no
   * editor yet (openTab→#setActiveTab can precede attachEditor) or its editor's
   * context is null, nothing is synthesized — the tab's own forward delivers the
   * first context once attached. A null active tab (teardown) emits a null
   * context to clear consumers.
   * @param {SieveTab|null} tab
   */
  #switchSelectionSource(tab) {
    if (this.#unsubActiveSelection) { this.#unsubActiveSelection(); this.#unsubActiveSelection = null }
    if (!tab) { this.#notifySelectionListeners(null); return }
    this.#unsubActiveSelection = tab.onSelectionUpdate((ctx) => this.#notifySelectionListeners(ctx))
    const synth = tab.editor ? tab.editor.getSelectionContext() : null
    if (synth) this.#notifySelectionListeners(synth)
  }

  #notifyActiveTabListeners() {
    const tab = this.#activeTab
    for (const fn of this.#activeTabListeners) {
      try { fn(tab) } catch (e) { console.error('[SieveWorkspace] activeTabChanged listener threw', e) }
    }
  }

  /** @param {import('../editor/selection-model.js').SelectionContext|null} ctx */
  #notifySelectionListeners(ctx) {
    for (const fn of this.#selectionListeners) {
      try { fn(ctx) } catch (e) { console.error('[SieveWorkspace] selectionUpdate listener threw', e) }
    }
  }

  /**
   * Debounces a lazy scroll-persist for the ACTIVE tab (issue #51 crash-safety
   * floor — "so a crash loses at most a few seconds"). One timer suffices:
   * only the active tab ever has a live editor to report scroll-changed from
   * (activateDocument destroys the previous one before a new one attaches).
   * @param {SieveTab} tab
   */
  #scheduleScrollPersist(tab) {
    if (this.#scrollPersistTimer) clearTimeout(this.#scrollPersistTimer)
    this.#scrollPersistTimer = setTimeout(() => {
      this.#scrollPersistTimer = null
      this.#persistScroll(tab)
    }, 3000)
  }

  /**
   * Pulls a tab's current scroll coordinate (via its editor's SelectionContext
   * — a PULL, never a push, per the issue #51 design) and persists it to
   * session.json: POST /api/session/scroll, the existing session-endpoint
   * pattern (ui/layout.js's /api/session/layout). Fire-and-forget — scroll is
   * caret-class state, not worth a save-suppression or a swap response.
   * No-op when the tab has no editor or never reported a scroll (ctx.scroll
   * null — nothing pulled yet, e.g. the user never scrolled this session).
   * @param {SieveTab} tab
   */
  #persistScroll(tab) {
    if (this.#scrollPersistTimer) { clearTimeout(this.#scrollPersistTimer); this.#scrollPersistTimer = null }
    const ctx = tab.editor ? tab.editor.getSelectionContext() : null
    if (!ctx || ctx.scroll == null) return
    const params = new URLSearchParams()
    params.append('id', tab.uuid)
    params.append('scroll', String(ctx.scroll))
    fetch('/api/session/scroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }).catch(() => {})
  }

  // ── Workspace-owned chrome children (P4.B: Ask panel; P4.C: dialogs + search) ─

  /** @type {AskPanel|null} the permanent Ask-panel child (constructed once) */
  #askPanel = null

  /** @type {InsertDialogs|null} the URL insert dialogs child (P4.C) */
  #insertDialogs = null

  /** @type {SearchOverlay|null} the document search overlay child (P4.C) */
  #searchOverlay = null

  /** @type {CommandBadges|null} the command badges child */
  #commandBadges = null

  /** @type {StatusBar|null} the status-bar child (P4.D — stats/dirty/blockid slots) */
  #statusBar = null

  /**
   * Constructs the Workspace-owned chrome children (P4.B: the Ask panel; P4.C: the
   * insert dialogs + search overlay; P4.D: the status bar). Called once at module
   * load next to startTabbar(). The AskPanel/StatusBar wire their structural DOM
   * and null-guard its absence (vitest imports the classes headless — the status
   * bar's slots resolve to null and every write no-ops).
   */
  bootChrome() {
    if (!this.#commandBadges) this.#commandBadges = new CommandBadges()
    if (!this.#askPanel) this.#askPanel = new AskPanel(this, this.#commandService, this.#commandBadges, this.#mentionService)
    if (!this.#insertDialogs) this.#insertDialogs = new InsertDialogs(this)
    if (!this.#searchOverlay) this.#searchOverlay = new SearchOverlay(this)
    if (!this.#statusBar) this.#statusBar = new StatusBar(this)
  }

  /** @returns {CommandBadges|null} */
  get commandBadges() { return this.#commandBadges }

  /** @returns {AskPanel|null} the permanent Ask-panel child (entry points reach it here) */
  get askPanel() { return this.#askPanel }

  /** @returns {InsertDialogs|null} the URL insert dialogs child (P4.C) */
  get insertDialogs() { return this.#insertDialogs }

  /** @returns {SearchOverlay|null} the document search overlay child (P4.C) */
  get searchOverlay() { return this.#searchOverlay }

  // ── Tabbar boot + SSE ownership (P2.D — relocated off the #htmx-tabbar div) ──

  /**
   * Boots the tab strip and subscribes to the out-of-band refresh signals the
   * div's hx-trigger carried before P2.D. The Workspace now OWNS the tabbar
   * render (loadTabs). MECHANISM: htmx's SSE extension fires `sse:*` as bubbling
   * CustomEvents on the divs that declare `hx-trigger="sse:…"` (sidebar/prompts/
   * meta still do), so a document-level listener receives them. The `… from:body`
   * body events (session:changed / notes:changed) likewise bubble to document.
   * Idempotent-safe to call once at module load; guards on #htmx-tabbar existing.
   */
  startTabbar() {
    const boot = () => { if (document.getElementById('htmx-tabbar')) this.loadTabs() }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true })
    } else {
      boot()
    }
    const refresh = () => this.loadTabs()
    document.addEventListener('sse:session:changed', refresh)
    document.addEventListener('sse:notes:changed', refresh)
    document.addEventListener('session:changed', refresh)
    document.addEventListener('notes:changed', refresh)
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
// Created once at module load time. editor.js looks this up via window.sieveWorkspace.
// Acceptance criterion: window.sieveWorkspace.activeTab.editor.uuid works from console.
const workspace = new SieveWorkspace()
window.sieveWorkspace = workspace

// P2.D: the Workspace owns the tab strip render. Boot it + subscribe to the SSE
// refresh signals here (module load — this is the deferred module, so the DOM
// mount exists or DOMContentLoaded is still pending, both handled). Guarded so
// vitest (which imports the class without a real document tab mount) is unaffected.
if (typeof document !== 'undefined') { workspace.startTabbar(); workspace.bootChrome(); workspace.bootEditorLifecycle() }
