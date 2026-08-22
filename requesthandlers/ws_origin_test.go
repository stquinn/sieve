package requesthandlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// The upgrade gate is DEFAULT-DENY. Both wires ride a loopback listener, and a
// loopback listener is reachable from any page the user has open in a browser —
// the same-origin policy does not apply to a WebSocket upgrade, so an allow-all
// check hands a drive-by page the document wire, which serves whole documents,
// creates blocks and (native-drop) reads local files.
func TestWS_AllowOrigin(t *testing.T) {
	srv, _, h, _ := newWsTestServer(t)
	_ = srv

	cases := []struct {
		name   string
		origin string
		want   bool
	}{
		// The production window: Wails serves the app from its own scheme, which no
		// web page can claim.
		{"the app's own wails scheme", "wails://wails", true},
		{"the dev window's wails scheme with the asset-server port", "wails://wails.localhost:34115", true},
		// `wails dev` in a real browser, which is how the UI is driven under test.
		{"the dev server on loopback", "http://127.0.0.1:34115", true},
		{"the dev server by name", "http://localhost:34115", true},
		{"loopback over IPv6", "http://[::1]:34115", true},
		// Not a browser at all: the contained CLI, a bare client, a test.
		{"no origin header", "", true},

		{"a foreign https page", "https://evil.example", false},
		{"a foreign http page", "http://evil.example:8080", false},
		// A sandboxed iframe or a file:// page. It is not the app, and admitting it
		// would admit every such page.
		{"the null origin", "null", false},
		{"a lookalike host", "http://127.0.0.1.evil.example", false},
		{"a scheme we do not serve", "file:///home/u/page.html", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/ws/workspace", nil)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if got := h.allowOrigin(r); got != tc.want {
				t.Errorf("allowOrigin(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

// The gate is wired into the upgrader, not merely defined: a refused origin never
// becomes a socket. 403 is what gorilla answers a failed CheckOrigin with.
func TestWS_ForeignOriginCannotUpgrade(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, _, _, uuid := newWsTestServer(t)

	wsURL := wsAddr(srv, "/api/ws/document/"+uuid)
	// WITH a valid token: the two gates compose, and this one must still refuse.
	_, resp, err := wsDialer().Dial(wsURL, http.Header{"Origin": []string{"https://evil.example"}})
	if err == nil {
		t.Fatal("a foreign origin must not reach the document wire")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for a refused origin, got %v", resp)
	}

	// The app's own window still connects — the gate must not be a blanket refusal.
	c, _, err := wsDialer().Dial(wsURL, http.Header{"Origin": []string{"wails://wails"}})
	if err != nil {
		t.Fatalf("the app's own origin must still connect: %v", err)
	}
	closeAndSettle(c)
}
