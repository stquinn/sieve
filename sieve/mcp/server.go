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
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/services"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type docContextKey struct{}

// WithDocument binds a target document UUID to ctx for side-effecting MCP verbs.
func WithDocument(ctx context.Context, docUUID string) context.Context {
	return context.WithValue(ctx, docContextKey{}, strings.TrimSpace(docUUID))
}

// DocumentFromContext returns the target document UUID bound to ctx, or empty string.
func DocumentFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	v, _ := ctx.Value(docContextKey{}).(string)
	return v
}

// Server is the internal Sieve MCP. It owns the transport-agnostic verb handlers
// (methods over the services), the SDK server + HTTP handler, and the per-run
// bearer-token registry that authenticates the CLI Sieve launches.
//
// Read verbs: search, get_meta, get_note, get_by_uri, list_facets. TWO verbs
// return bodies — get_note names its target by uuid, get_by_uri by coordinate —
// and both MUST record the same bodyRead audit through one auditor, which is
// what keeps bulk-read visible at a single boundary.
//
// Side-effecting verb: fetch_page writes a readable HTML asset into the
// calling job's own document (and nowhere else), returning its NodeDescriptor.
type Server struct {
	documents    *services.DocumentService
	nodes        NodeResolver // address → NodeDescriptor; the concrete Router is injected at the root
	linkPreview  *services.LinkPreviewService
	fetchTimeout time.Duration
	audit        bodyReadAuditor // every body read, recorded at one place

	sdk     *mcpsdk.Server
	handler http.Handler // StreamableHTTPHandler, built once

	mu      sync.RWMutex
	baseURL string            // e.g. "http://127.0.0.1:34115"; set once the listener is bound
	tokens  map[string]string // valid per-run bearer tokens → bound document UUID ("" when unscoped)
}

// pageFetchTimeout is fetch_page's deadline for retrieving one page.
const pageFetchTimeout = 15 * time.Second

// NewServer builds the Sieve MCP over the document service, the node resolver
// and the link-preview service fetch_page retrieves pages through, registers the
// verbs, and prepares the streamable HTTP handler. The base URL is not known yet
// (the listener binds after construction) — SetBaseURL supplies it.
func NewServer(documents *services.DocumentService, nodes NodeResolver, linkPreview *services.LinkPreviewService) *Server {
	s := &Server{
		documents:    documents,
		nodes:        nodes,
		linkPreview:  linkPreview,
		fetchTimeout: pageFetchTimeout,
		audit:        logAuditor{},
		tokens:       make(map[string]string),
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
		Name: "get_meta",
		Description: "Return the full metadata for one note by uuid (title, folder, tags, summary, timestamps, version, AI evaluation). No body. " +
			"Takes a bare uuid only: a sieve:// uri belongs to get_by_uri.",
	}, s.getMeta)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: "get_note",
		Description: "Return one note by uuid: its metadata plus the full markdown body. " +
			"Use this when you have a bare uuid; a sieve:// uri belongs to get_by_uri, which takes it verbatim.",
	}, s.getNote)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: "get_by_uri",
		Description: "Return whatever a Sieve uri points at: its title, metadata and full markdown body. " +
			"Pass the uri exactly as it appears in an ATTACHED DOCUMENTS manifest (e.g. sieve://{uuid}) — copy it, never construct one. " +
			"A uri naming a file answers with kind \"asset\", no body, its size in bytes, and a path relative to the library root (a directory you are granted): read that path from disk, as no tool returns a file's bytes.",
	}, s.getByURI)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        "list_facets",
		Description: "Return the knowledge base's orientation facets: folders with note counts and tags with counts.",
	}, s.listFacets)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: "fetch_page",
		Description: "Fetch an http or https URL, extract its readable article content as HTML, and write it as an asset into the job's own document. " +
			"Returns the asset's NodeDescriptor (uri, id, kind \"asset\", title, path, bytes); the asset is an HTML file you can read from disk at path. " +
			"On failure returns 'cannot retrieve: {reason}' so you can fall back to other tools.",
	}, s.fetchPage)

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
	return s.EndpointForDoc("")
}

// EndpointForDoc issues a per-call bearer token bound to docUUID so
// side-effecting verbs (fetch_page) write only into that document's assets.
func (s *Server) EndpointForDoc(docUUID string) (url, token string) {
	s.mu.RLock()
	base := s.baseURL
	s.mu.RUnlock()
	if base == "" {
		return "", ""
	}
	tok := s.issueToken(docUUID)
	return base + "/mcp", tok
}

func (s *Server) issueToken(docUUID string) string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		logger.Error("sieve mcp: token generation failed", "err", err)
		return ""
	}
	tok := hex.EncodeToString(buf)
	s.mu.Lock()
	s.tokens[tok] = strings.TrimSpace(docUUID)
	s.mu.Unlock()
	return tok
}

func (s *Server) tokenDoc(tok string) (string, bool) {
	if tok == "" {
		return "", false
	}
	s.mu.RLock()
	docUUID, ok := s.tokens[tok]
	s.mu.RUnlock()
	return docUUID, ok
}

// ServeHTTP authenticates the request against the per-run bearer token registry,
// binds the token's document UUID into the request context when present, and
// delegates to the streamable MCP handler. Unauthenticated requests are
// rejected — only the CLI Sieve launched (holding the injected token) may reach
// the knowledge base.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	docUUID, ok := s.tokenDoc(s.bearerToken(r))
	if !ok {
		// A hit on the localhost MCP without a valid per-run token is security-
		// relevant (only the CLI Sieve launched should reach it) — surface it.
		logger.Warn("sieve mcp: unauthorized request rejected", "remote", r.RemoteAddr, "path", r.URL.Path)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if docUUID != "" {
		r = r.WithContext(WithDocument(r.Context(), docUUID))
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
