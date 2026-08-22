package requesthandlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"sieve/sieve/mcp"
	"sieve/sieve/protocol"
)

// testWSToken stands in for the token main mints per run. Every dial in this
// package presents it (wsDialer), so a test that means to be refused has to say
// so explicitly rather than by omission.
const testWSToken = "test-ws-token-6f3a2b1c"

// wsDialer is THE dialer the package's tests dial with: it offers the version
// word and the token, exactly as the browser half does.
func wsDialer() *websocket.Dialer {
	d := *websocket.DefaultDialer
	d.Subprotocols = []string{protocol.WSSubprotocol, testWSToken}
	return &d
}

// wsAddr is a wire's ws:// address on a test server.
func wsAddr(srv *httptest.Server, path string) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + path
}

// Both wires ride a loopback listener that any local process on the machine can
// reach, and a non-browser process forges an Origin freely — so allowOrigin,
// which stops a drive-by browser page, stops nothing else. The token is what
// identifies the peer, and an upgrade without one is refused BEFORE it becomes a
// socket: 401, not a connection that dies later.
func TestWS_UpgradeWithoutATokenIsRefused(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	for _, tc := range []struct {
		name string
		path string
	}{
		{"document wire", "/api/ws/document/" + uuid},
		{"workspace wire", "/api/ws/workspace"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, resp, err := websocket.DefaultDialer.Dial(wsAddr(srv, tc.path), nil)
			if err == nil {
				conn.Close()
				t.Fatal("a dial presenting no token must not reach the wire")
			}
			if resp == nil || resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("want 401 for an unauthenticated upgrade, got %v", resp)
			}
		})
	}
}

// A guessed token is a refused token: the comparison is against this run's
// secret, not against any well-formed-looking string.
func TestWS_UpgradeWithAWrongTokenIsRefused(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	d := *websocket.DefaultDialer
	d.Subprotocols = []string{protocol.WSSubprotocol, "not-the-token"}
	conn, resp, err := d.Dial(wsAddr(srv, "/api/ws/document/"+uuid), nil)
	if err == nil {
		conn.Close()
		t.Fatal("a dial presenting the wrong token must not reach the wire")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 for a wrong token, got %v", resp)
	}
}

// The handshake answers with the VERSION word alone. The token is a credential:
// echoing it back would publish it to anything that can see the response — which
// is why the upgrader is given a Subprotocols list at all.
func TestWS_UpgradeWithTheTokenEchoesOnlyTheVersionWord(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	conn, resp, err := wsDialer().Dial(wsAddr(srv, "/api/ws/document/"+uuid), nil)
	if err != nil {
		t.Fatalf("the shell's own dial must connect: %v", err)
	}
	defer closeAndSettle(conn)

	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("want 101, got %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != protocol.WSSubprotocol {
		t.Errorf("negotiated subprotocol = %q, want %q", got, protocol.WSSubprotocol)
	}
	if got := conn.Subprotocol(); got != protocol.WSSubprotocol {
		t.Errorf("conn.Subprotocol() = %q, want %q", got, protocol.WSSubprotocol)
	}
	for name, values := range resp.Header {
		for _, v := range values {
			if strings.Contains(v, testWSToken) {
				t.Errorf("the token came back in response header %s: %q", name, v)
			}
		}
	}
}

// The two token registries are DISJOINT. The MCP endpoint and the WS wires share
// one loopback listener, and the AI CLI Sieve launches is handed an MCP token —
// so a token that opened both would hand the contained CLI the document wire,
// which creates blocks, serves whole documents and reads local files.
func TestWS_AnMCPTokenCannotOpenAWire(t *testing.T) {
	srv, sp, _, uuid := newWsTestServer(t)

	mcpServer := mcp.NewServer(sp.Documents, nil)
	mcpServer.SetBaseURL(srv.URL)
	_, mcpToken := mcpServer.Endpoint()
	if mcpToken == "" {
		t.Fatal("the MCP server issued no token: the disjointness claim is untested")
	}

	d := *websocket.DefaultDialer
	d.Subprotocols = []string{protocol.WSSubprotocol, mcpToken}
	conn, resp, err := d.Dial(wsAddr(srv, "/api/ws/document/"+uuid), nil)
	if err == nil {
		conn.Close()
		t.Fatal("an MCP token opened a WebSocket wire")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 for an MCP token, got %v", resp)
	}
}

// The header is a list, and a client may send it as several lines. Both
// spellings carry the same offer, so both are read — a handler that looked at
// only the first line would refuse a perfectly good dial.
func TestWsHandler_OffersToken_ReadsTheWholeProtocolList(t *testing.T) {
	h := &WsHandler{token: testWSToken}

	cases := []struct {
		name   string
		header []string
		want   bool
	}{
		{"one line, token second", []string{protocol.WSSubprotocol + ", " + testWSToken}, true},
		{"one line, token alone", []string{testWSToken}, true},
		{"several lines", []string{protocol.WSSubprotocol, testWSToken}, true},
		{"no token", []string{protocol.WSSubprotocol}, false},
		{"a prefix of the token", []string{protocol.WSSubprotocol + ", " + testWSToken[:8]}, false},
		{"no header at all", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/ws/workspace", nil)
			for _, v := range tc.header {
				r.Header.Add("Sec-WebSocket-Protocol", v)
			}
			if got := h.offersToken(r); got != tc.want {
				t.Errorf("offersToken(%v) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}

// A handler with no token configured refuses everything, including the empty
// string a trailing comma in the header produces. The alternative — treating "no
// token" as "no gate" — would open both wires on exactly the startup failure
// that leaves the token empty.
func TestWsHandler_OffersToken_EmptyExpectedTokenRefusesEveryone(t *testing.T) {
	h := &WsHandler{}

	for _, offered := range []string{"", protocol.WSSubprotocol + ",", protocol.WSSubprotocol + ", anything"} {
		r := httptest.NewRequest(http.MethodGet, "/api/ws/workspace", nil)
		r.Header.Set("Sec-WebSocket-Protocol", offered)
		if h.offersToken(r) {
			t.Errorf("an unconfigured handler admitted the offer %q", offered)
		}
	}
}
