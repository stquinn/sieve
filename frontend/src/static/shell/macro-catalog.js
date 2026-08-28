// @ts-check
// The host's answer to "what can a `{` do here": the catalog of MACROS the
// trigger picker offers.
//
// MACROS ARE TO THE FRONTEND WHAT COMMANDS ARE TO THE BACKEND. A command is a
// backend verb — declared in Go beside the logic it runs, enumerated to clients,
// dispatched over the wire. A macro is a frontend verb — declared beside the
// capability it fronts, enumerated to whatever renders verbs (the `{` picker
// now, a toolbar later), invoked with the caret's token. A new verb picks its
// side by WHERE ITS LOGIC HAPPENS: mutating domain state is a command, driving a
// frontend capability (a dialog, native editing) is a macro.
//
// AN ENTRY IS DECLARED WHERE ITS CAPABILITY LIVES. The workspace owns the Web
// Clip dialog and the toolbar's attach flow, so those verbs are declared here;
// a surface's PM-native presets are declared on that surface and appended at
// the mount that composes them.
//
// ONE DOOR PER DESTINATION: the Web Clip dialog's "Card" rung already makes a
// smart-card, so the picker carries no separate Link Card entry to the same
// place.

import { getSieveIcon } from '../renderers/block-kinds.js'
import { listInsertableKinds } from '../renderers/block-renderers.js'
import { BlockMacro, ActionMacro } from './trigger-providers.js'
import { ContractViolation } from '../contract/sieve-block.js'

/**
 * The workspace verbs this catalog fronts — the one-call dialog opener the
 * toolbar and the context menu already call, and the active Tab the Attach
 * File verb reads its editor from.
 * @typedef {object} InsertDialogHost
 * @property {(url?: string) => void} openWebClipDialog
 * @property {{editor: import('../lens/abstract-editor.js').AbstractEditor|null}|null} activeTab
 */

export class MacroCatalog {
  /** @type {InsertDialogHost} */ #dialogs

  /** @param {InsertDialogHost} dialogs  the workspace, whose Web Clip dialog the
   *   URL entry fronts. Read at RUN time, so a catalog built before the chrome
   *   boots still reaches the dialogs once they exist. */
  constructor(dialogs) {
    if (!dialogs) throw new ContractViolation('MacroCatalog requires a dialog host')
    this.#dialogs = dialogs
  }

  /**
   * Every entry this host offers, kinds first. READ FRESH each time: a kind's
   * icon resolves through the renderer registry and its defaults are the create
   * path's to enrich, so neither may be shared between two acceptances.
   * @returns {import('./trigger-providers.js').Macro[]}
   */
  list() {
    const dialogs = this.#dialogs
    /** @type {import('./trigger-providers.js').Macro[]} */
    const entries = listInsertableKinds().map((kind) => new BlockMacro(kind))
    return entries.concat([
      new ActionMacro({
        label: 'Web Clip',
        name: 'web-clip',
        description: 'Capture a page from a URL',
        icon: getSieveIcon('web-clip'),
        action: () => dialogs.openWebClipDialog(),
      }),
      new ActionMacro({
        label: 'Attach File',
        name: 'image',
        description: 'A file — the paste pipeline decides its block',
        icon: MacroCatalog.#attachIcon(),
        action: () => MacroCatalog.#attachFile(dialogs),
      }),
    ])
  }

  /**
   * Mirrors the toolbar's Attach File button exactly: capture the insert
   * anchor before the OS file picker opens (opening it blurs the editor and
   * the caret would re-derive to document end), stash it where the app
   * shell's change handler reads it, and click the hidden file input. This
   * macro never names or creates a block kind — the paste-match registry
   * decides that from the bytes the picker returns.
   * @param {InsertDialogHost} dialogs
   */
  static #attachFile(dialogs) {
    const editor = dialogs.activeTab && dialogs.activeTab.editor
    if (!editor) return
    /** @type {any} */ (window).__sieveCapturedInsertAnchor = editor.captureImageInsert()
    const input = document.getElementById('tb-attach-input')
    if (input) /** @type {HTMLInputElement} */ (input).click()
  }

  /** @returns {string} the toolbar's own paperclip icon, read the same way it does */
  static #attachIcon() {
    const icons = /** @type {any} */ (window).SieveIcons
    return (icons && icons.paperclip) || ''
  }
}
