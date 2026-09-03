// @ts-check
// spell-control.js — SpellControl: the workspace's spelling verbs. It sends what
// a reader's judgements about words travel as — accept this word for now, accept
// it for good — plus the control frame that switches the feature itself off and
// on, and holds the one piece of state the client keeps about spelling: whether
// the toggle is on.
//
// The toggle is NOT a spelling verb. It rides the one lifecycle frame every
// text-service producer shares, naming spelling as its subject; the two word
// verbs are spelling's own, because accepting a word is a judgement about that
// word and not about whether the feature runs.
//
// It is a SENDER, not a tenant: none of the three is answered. What a client
// sees of any of them is the marks that follow on each document's own channel,
// which the lens already draws without knowing why they changed.
//
// The toggle's state is a persisted GLOBAL. The page is told it at boot and the
// server owns it thereafter, so this holds the last value it sent rather than
// asking: the button has to repaint the instant it is pressed.

import { Feature, WorkspaceFrame } from '../generated/protocol.js'

export class SpellControl {
  /** @type {import('./workspace-service.js').WorkspaceService} */ #workspace
  /** @type {boolean} */ #enabled

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   * @param {boolean} enabled the persisted setting as the page was served it
   */
  constructor(workspace, enabled) {
    this.#workspace = workspace
    this.#enabled = enabled !== false
  }

  /** @returns {boolean} whether spell checking is on */
  get enabled() { return this.#enabled }

  /**
   * Flips the toggle and tells the server, which persists it and either clears
   * every mark or re-checks every open document. It goes as the workspace-wide
   * feature-control frame — the wire the toggle arrives on is what says the
   * answer is for the whole app rather than for one document.
   *
   * Spelling takes no parameters: it is on or off. The empty bag still travels,
   * because the frame's shape is the same for every feature.
   * @returns {boolean} the state flipped INTO
   */
  toggle() {
    this.#enabled = !this.#enabled
    this.#workspace.send({
      type: WorkspaceFrame.FEATURE_CONTROL,
      feature: Feature.SPELL_CHECK,
      enabled: this.#enabled,
      parameters: {},
    })
    return this.#enabled
  }

  /**
   * Stops flagging a word for the rest of this run.
   * @param {string} word as it was written; the server folds it
   */
  ignore(word) {
    if (!word) return
    this.#workspace.send({ type: WorkspaceFrame.SPELL_IGNORE, word: word })
  }

  /**
   * Adds a word to the user's dictionary, which survives a restart.
   * @param {string} word as it was written; the server folds it
   */
  learn(word) {
    if (!word) return
    this.#workspace.send({ type: WorkspaceFrame.SPELL_LEARN, word: word })
  }
}
