package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// authProbe posts to the server's ServeHTTP with the given Authorization header
// and returns the status code.
func authProbe(t *testing.T, s *Server, auth string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec.Code
}

func TestAuth_RejectsWithoutToken(t *testing.T) {
	s := newTestServer(t)

	if code := authProbe(t, s, ""); code != http.StatusUnauthorized {
		t.Errorf("no Authorization header: status = %d, want 401", code)
	}
	if code := authProbe(t, s, "Bearer deadbeef"); code != http.StatusUnauthorized {
		t.Errorf("unregistered token: status = %d, want 401", code)
	}
}

// The WS upgrade credential (App.WSToken) and the MCP registry are disjoint in
// BOTH directions: requesthandlers proves an MCP token cannot open a wire, and
// this proves the mirror — a well-formed 64-hex credential that is valid
// elsewhere in the process opens nothing here, because membership of THIS
// server's set is the only thing that passes. Minted inline since the WS token
// itself lives in package main; any non-member is equivalent by construction.
func TestAuth_RejectsAForeignToken(t *testing.T) {
	s := newTestServer(t)

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	if code := authProbe(t, s, "Bearer "+hex.EncodeToString(buf)); code != http.StatusUnauthorized {
		t.Errorf("foreign 64-hex token: status = %d, want 401", code)
	}
}

func TestAuth_AcceptsIssuedToken(t *testing.T) {
	s := newTestServer(t)
	s.SetBaseURL("http://127.0.0.1:34115")

	url, token := s.Endpoint()
	if url != "http://127.0.0.1:34115/mcp" {
		t.Fatalf("Endpoint url = %q", url)
	}
	if token == "" {
		t.Fatal("Endpoint returned empty token")
	}

	// A registered token passes auth (the streamable handler then responds; any
	// non-401 status proves the auth gate let it through).
	if code := authProbe(t, s, "Bearer "+token); code == http.StatusUnauthorized {
		t.Errorf("issued token rejected: status = %d, want != 401", code)
	}
}

func TestEndpoint_EmptyWhenNoBaseURL(t *testing.T) {
	s := newTestServer(t)
	url, token := s.Endpoint()
	if url != "" || token != "" {
		t.Errorf("no base URL: Endpoint = (%q, %q), want empty", url, token)
	}
}
