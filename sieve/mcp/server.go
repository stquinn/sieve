// Package mcp serves the internal Sieve MCP: a read-only, localhost-only Model
// Context Protocol surface over the knowledge base. It is the uniform capability
// plane injected into contained AI CLI calls (see the AI CLI containment design,
// docs/design/specs/2026-07-16-ai-cli-containment-and-sieve-mcp-design.md).
//
// The package depends only on services + domain; nothing depends back on it. It
// is constructed at the composition root, mounted at /mcp on the chi router, and
// its Endpoint() feeds the runtime URL + per-call bearer token into the
// containment profile the AI service renders to CLI args.
package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"

	"sieve/logger"
	"sieve/sieve/services"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Server is the internal Sieve MCP. It owns the transport-agnostic verb handlers
// (methods over the services), the SDK server + HTTP handler, and the per-run
// bearer-token registry that authenticates the CLI Sieve launches.
//
// Read-only v1: search, get_meta, get_note, list_facets. Bodies are returned
// only by get_note, so bulk-read is visible at a single Sieve-owned boundary.
type Server struct {
	documents *services.DocumentService

	sdk     *mcpsdk.Server
	handler http.Handler // StreamableHTTPHandler, built once

	mu      sync.RWMutex
	baseURL string              // e.g. "http://127.0.0.1:34115"; set once the listener is bound
	tokens  map[string]struct{} // valid per-run bearer tokens
}

// NewServer builds the Sieve MCP over the document service, registers the four
// read-only verbs, and prepares the streamable HTTP handler. The base URL is not
// known yet (the listener binds after construction) — SetBaseURL supplies it.
func NewServer(documents *services.DocumentService) *Server {
	s := &Server{
		documents: documents,
		tokens:    make(map[string]struct{}),
	}

	sdk := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "sieve",
		Title:   "Sieve knowledge base",
		Version: "v1",
	}, nil)

	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        "search",
		Description: "Search the knowledge base by a case-insensitive substring matched against note titles, summaries and tags. Returns metadata only (never note bodies). Optionally restrict to a folder.",
	}, s.search)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        "get_meta",
		Description: "Return the full metadata for one note by uuid (title, folder, tags, summary, timestamps, version, AI evaluation). No body.",
	}, s.getMeta)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        "get_note",
		Description: "Return one note by uuid: its metadata plus the full markdown body. This is the only verb that returns note content.",
	}, s.getNote)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        "list_facets",
		Description: "Return the knowledge base's orientation facets: folders with note counts and tags with counts.",
	}, s.listFacets)

	s.sdk = sdk
	s.handler = mcpsdk.NewStreamableHTTPHandler(func(*http.Request) *mcpsdk.Server {
		return sdk
	}, nil)
	return s
}

// SetBaseURL records the origin the CLI subprocess reaches the app on (the
// standalone localhost listener bound in main). Called after startup, when the
// port is known; safe to call again on library switch.
func (s *Server) SetBaseURL(base string) {
	s.mu.Lock()
	s.baseURL = strings.TrimRight(base, "/")
	s.mu.Unlock()
}

// Endpoint issues a fresh per-call bearer token, registers it, and returns the
// /mcp URL + token to inject into the containment profile. An empty URL (no
// listener yet) means no server is reachable, so the profile renders without MCP
// flags. Implements the ai.MCPEndpoint seam.
//
// Tokens are not revoked after the call — they are localhost-only, bound to
// 127.0.0.1, and live only for the app session. This is an accepted minor
// accumulation for v1 (noted; revoke-on-completion is a future refinement).
func (s *Server) Endpoint() (url, token string) {
	s.mu.RLock()
	base := s.baseURL
	s.mu.RUnlock()
	if base == "" {
		return "", ""
	}
	tok := s.issueToken()
	return base + "/mcp", tok
}

// Ready reports whether a listener has bound — the same condition Endpoint's URL
// half answers, WITHOUT issuing a token. Callers asking a pure capability
// question ("can a contained CLI reach MCP at all?") use this, so merely asking
// never adds to the accepted token accumulation above.
func (s *Server) Ready() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.baseURL != ""
}

func (s *Server) issueToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		logger.Error("sieve mcp: token generation failed", "err", err)
		return ""
	}
	tok := hex.EncodeToString(buf)
	s.mu.Lock()
	s.tokens[tok] = struct{}{}
	s.mu.Unlock()
	return tok
}

func (s *Server) tokenValid(tok string) bool {
	if tok == "" {
		return false
	}
	s.mu.RLock()
	_, ok := s.tokens[tok]
	s.mu.RUnlock()
	return ok
}

// ServeHTTP authenticates the request against the per-run bearer token registry,
// then delegates to the streamable MCP handler. Unauthenticated requests are
// rejected — only the CLI Sieve launched (holding the injected token) may reach
// the knowledge base.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.tokenValid(s.bearerToken(r)) {
		// A hit on the localhost MCP without a valid per-run token is security-
		// relevant (only the CLI Sieve launched should reach it) — surface it.
		logger.Warn("sieve mcp: unauthorized request rejected", "remote", r.RemoteAddr, "path", r.URL.Path)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.handler.ServeHTTP(w, r)
}

// bearerToken extracts the token from an "Authorization: Bearer <token>" header.
func (s *Server) bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}
