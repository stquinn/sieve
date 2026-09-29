// @ts-check
// Format, as both menus offer it: the Sieve code block's own menu and the prose
// menu's native-fence section. One class so the offer rule and the write are
// stated once.
//
// THE FORMATTER COMPUTES A STRING AND THIS WRITES IT, as one TRACKED ProseMirror
// transaction over the node's own range. Tracked is the whole point: Ctrl+Z
// reverts a format like any other edit, and the write reaches the server by the
// path that already carries typing — the node view's MutationObserver for a code
// block, the prose save path for a fence. Nothing here knows about persistence.
//
// THE POSITION IS RE-READ AFTER THE AWAIT. Formatting takes milliseconds but the
// document is free to move underneath it — a watcher reload, an AI job landing a
// block — so what was at that position is checked to still be the same kind of
// node before anything is written to it.

export class CodeFormatAction {
  /**
   * The Format menu item for one code node, or null when it is not on offer.
   * Both conditions are necessary: something has to be able to format this
   * language, and the target has to be writable at all.
   *
   * @param {object}   target
   * @param {any}      target.lens      the mount the node belongs to; holds the service
   * @param {any}      target.pane      the TipTap pane the node lives in
   * @param {any}      target.node      the code node to format
   * @param {() => (number|null)} target.getPos  where that node currently is
   * @param {string}   target.language  the node's language, canonical or an alias
   * @param {boolean}  target.editable  whether this mount may be written to
   * @returns {{icon: any, label: string, action: () => void}|null}
   */
  static offer({ lens, pane, node, getPos, language, editable }) {
    const service = lens && lens.codeFormattingService
    if (!editable || !service || !service.supports(language)) return null
    return {
      icon: (window.SieveIcons || {}).edit || null,
      label: 'Format',
      action: () => { void CodeFormatAction.run({ service, pane, node, getPos, language }) },
    }
  }

  /**
   * Formats the node and writes the result. Resolves when it has done so or
   * decided not to; it never rejects, because a menu pick has no caller to tell.
   *
   * @param {object} arg
   * @param {any}    arg.service  the formatting service
   * @param {any}    arg.pane     the TipTap pane
   * @param {any}    arg.node     the node as the menu saw it
   * @param {() => (number|null)} arg.getPos
   * @param {string} arg.language
   * @returns {Promise<void>}
   */
  static async run({ service, pane, node, getPos, language }) {
    let formatted
    try {
      formatted = await service.format(language, node.textContent)
    } catch (err) {
      window.alert('Format failed: ' + ((err && err.message) || err))
      return
    }
    const pos = typeof getPos === 'function' ? getPos() : null
    const state = pane && pane.state
    if (!state || pos == null || pos < 0 || pos >= state.doc.content.size) return
    const current = state.doc.nodeAt(pos)
    if (!current || current.type !== node.type || current.textContent === formatted) return
    const tr = state.tr
    tr.replaceWith(pos + 1, pos + 1 + current.content.size,
      formatted ? state.schema.text(formatted) : [])
    pane.view.dispatch(tr)
  }
}
