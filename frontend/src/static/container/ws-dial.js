// @ts-check
// How the two wires are DIALLED, as opposed to what they carry. Both wire owners
// present the SAME credential from here, so the token is read in one place.

import { WS_SUBPROTOCOL } from '../generated/protocol.js'

export class WsDial {
  /**
   * The version word Go selects, then this run's token. The token rides the
   * subprotocol because the browser WebSocket API cannot set a request header, and
   * Go reads it off Sec-WebSocket-Protocol before it upgrades. With no token the
   * version word goes alone and Go refuses the upgrade.
   * @returns {string[]}
   */
  static protocols() {
    const token = typeof window === 'undefined' ? '' : /** @type {any} */ (window).__sieveWsToken
    return token ? [WS_SUBPROTOCOL, token] : [WS_SUBPROTOCOL]
  }
}
