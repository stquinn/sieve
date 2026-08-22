// @ts-check
// ws-dial.js — WsDial: how the two wires are DIALLED, as opposed to what they
// carry once open.
//
// It exists so both wire owners (block-service.js's document channels and
// workspace-service.js's workspace channel) present the SAME credential. A
// second copy of this read is a second thing to forget when the shell stops
// serving the token, and the failure mode is one wire silently refused while
// the other connects.

import { WS_SUBPROTOCOL } from '../generated/protocol.js'

export class WsDial {
  /**
   * The subprotocol list a dial offers: the version word Go selects, then this
   * run's token. The token rides here because the browser WebSocket API cannot
   * set a request header, and Go reads it off Sec-WebSocket-Protocol before it
   * upgrades anything (`requesthandlers/ws_handler.go` authorizeUpgrade).
   *
   * With no token in the page — a test env, or a shell that never rendered one
   * — the version word goes alone and Go refuses the upgrade. That is the
   * honest outcome: fabricating an entry would only turn a refusal into a
   * handshake failure further down.
   * @returns {string[]}
   */
  static protocols() {
    const token = typeof window === 'undefined' ? '' : /** @type {any} */ (window).__sieveWsToken
    return token ? [WS_SUBPROTOCOL, token] : [WS_SUBPROTOCOL]
  }
}
