// Package mcp serves the internal Sieve MCP: a read-only, localhost-only Model
// Context Protocol surface over the knowledge base. It is the uniform capability
// plane injected into contained AI CLI calls (see the AI CLI containment design,
// docs/design/specs/2026-07-16-ai-cli-containment-and-sieve-mcp-design.md).
//
// The package depends only on services + domain; nothing depends back on it. It
// is constructed at the composition root, mounted at /mcp on the chi router, and
// its EndpointFor() feeds the runtime URL + per-call bearer token into the
// containment profile the AI service renders to CLI args.
package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type grantContextKey struct{}

// runGrant is what one per-run bearer token is bound to: the exchange the run
// may write into, whether it may call the write verbs at all, how many
// elements it has written to that exchange's answer, and whether the run has
// ended. Its mutex serialises a run's answer writes with each other and with
// its end, so the first write is known and none lands after the end.
type runGrant struct {
	exchange domain.Exchange
	writes   bool

	mu      sync.Mutex
	written int
	ended   bool
}

// refuseWrite is nil when the run g is bound to may call a write verb, and
// otherwise the refusal of verb. A nil grant may not write.
func (g *runGrant) refuseWrite(verb string) error {
	if g != nil && g.writes {
		return nil
	}
	return fmt.Errorf("%s: this run returns its result to Sieve and writes nothing into a document", verb)
}

// bind returns ctx carrying g.
func (g *runGrant) bind(ctx context.Context) context.Context {
	return context.WithValue(ctx, grantContextKey{}, g)
}

// WithDocument binds a target document UUID to ctx for side-effecting MCP verbs,
// with the right to call the write verbs.
func WithDocument(ctx context.Context, docUUID string) context.Context {
	return (&runGrant{exchange: domain.Exchange{Container: strings.TrimSpace(docUUID)}, writes: true}).bind(ctx)
}

// DocumentFromContext returns the target document UUID bound to ctx, or empty string.
func DocumentFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if g, ok := ctx.Value(grantContextKey{}).(*runGrant); ok {
		return g.exchange.Container
	}
	return ""
}

// Server is the internal Sieve MCP. It owns the transport-agnostic verb handlers
// (methods over the services), the SDK server + HTTP handler, and the per-run
// bearer-token registry that authenticates the CLI Sieve launches.
//
// Read verbs: search, get_meta, get_note, get_by_uri, list_facets. TWO verbs
// return bodies — get_note names its target by address, get_by_uri likewise —
// and both MUST record the same bodyRead audit through one auditor, which is
// what keeps bulk-read visible at a single boundary.
//
// fetch_page fetches a web page for a run whose own fetch is blocked. It keeps
// the readable HTML as an asset of the calling job's own document (and nowhere
// else) and returns its NodeDescriptor; keeping the page changes nothing a
// reader sees, so it is a read verb.
//
// Write verbs, which a run that returns its result to Sieve may not call:
// add_to_answer, once answers are opened (OpenAnswers), appends one block to the
// answer of the exchange the run's token is bound to, and describe_answer lists
// the content types it takes.
type Server struct {
	documents    *services.DocumentService
	nodes        NodeResolver  // address → NodeDescriptor; the concrete Router is injected at the root
	finder       SearchService // criteria → hits; the same Router
	linkPreview  *services.LinkPreviewService
	fetchTimeout time.Duration
	audit        bodyReadAuditor                      // every body read, recorded at one place
	vocabulary   AnswerVocabulary                     // content type + attrs → answer element; nil until OpenAnswers
	answers      map[domain.AnswerHolder]AnswerWriter // appends an element to an exchange's answer, by its holder; nil until OpenAnswers

	sdk     *mcpsdk.Server
	handler http.Handler // StreamableHTTPHandler, built once

	mu         sync.RWMutex
	baseURL    string               // e.g. "http://127.0.0.1:34115"; set once the listener is bound
	tokens     map[string]*runGrant // valid per-run bearer tokens → what each is bound to
	readVerbs  []string             // the verbs that only read, in registration order
	writeVerbs []string             // the verbs that write into a document: the answer verbs, once OpenAnswers has registered them
}

// pageFetchTimeout is fetch_page's deadline for retrieving one page.
const pageFetchTimeout = 15 * time.Second

// NewServer builds the Sieve MCP over the document service, the node resolver,
// the search service and the link-preview service fetch_page retrieves pages
// through, registers the verbs, and prepares the streamable HTTP handler. The
// base URL is not known yet (the listener binds after construction) —
// SetBaseURL supplies it.
func NewServer(documents *services.DocumentService, nodes NodeResolver, search SearchService, linkPreview *services.LinkPreviewService) *Server {
	s := &Server{
		documents:    documents,
		nodes:        nodes,
		finder:       search,
		linkPreview:  linkPreview,
		fetchTimeout: pageFetchTimeout,
		audit:        logAuditor{},
		tokens:       make(map[string]*runGrant),
	}

	sdk := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "sieve",
		Title:   "Sieve knowledge base",
		Version: "v1",
	}, nil)

	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: s.readVerb("search"),
		Description: "Search the knowledge base by a case-insensitive substring matched against names, summaries and tags — never bodies. " +
			"Finds filed notes (kind \"note\"), unfiled buffers (kind \"buffer\"), notebooks written on a SieveInk device (kind \"digital-note\"; found by name, summary and keywords) and the Live view while it exists (kind \"ink-live\"; found by name). " +
			"A buffer has no summary or tags, so it is found by its name alone. " +
			"An empty query lists everything. Returns metadata only (never bodies); each hit is named by its address (uri), which get_meta, get_note and get_by_uri take as given. " +
			"Optionally restrict to a folder, which leaves out everything but filed notes, as nothing else has one.",
	}, s.search)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: s.readVerb("get_meta"),
		Description: "Return the full metadata for one note (title, folder, tags, summary, timestamps, version, AI evaluation). No body. " +
			"Takes a note's address, sieve://{container}. An address naming a block or file inside a note, sieve://{container}/{leaf}, belongs to get_by_uri.",
	}, s.getMeta)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: s.readVerb("get_note"),
		Description: "Return one note: its metadata plus the full markdown body. " +
			"Takes a note's address, sieve://{container}. An address naming a block or file inside a note, sieve://{container}/{leaf}, belongs to get_by_uri.",
	}, s.getNote)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: s.readVerb("get_by_uri"),
		Description: "Return whatever a sieve:// address names: its title, metadata and full markdown body. " +
			"Takes an address: sieve://{container} for a note or other container, sieve://{container}/{leaf} for a block or file inside one. " +
			"An address naming a file answers with kind \"asset\", no body, its size in bytes, and a path relative to the library root (a directory you are granted): read that path from disk, as no tool returns a file's bytes. " +
			"An address naming a whole container also lists, under \"assets\", every file it holds — images, attachments, a notebook's page images and transcripts — each with its own uri to pass back here, its key, its size in bytes and its path.",
	}, s.getByURI)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name:        s.readVerb("list_facets"),
		Description: "Return the knowledge base's orientation facets: folders with note counts and tags with counts.",
	}, s.listFacets)
	mcpsdk.AddTool(sdk, &mcpsdk.Tool{
		Name: s.readVerb("fetch_page"),
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

// OpenAnswers registers add_to_answer and describe_answer over vocabulary and
// writers, the writer of each holder an exchange's block can live in. Which
// content types a run may write is decided by its holder's writer
// (AnswerHolding), so add_to_answer's description names none and points to
// describe_answer, which lists this run's.
func (s *Server) OpenAnswers(vocabulary AnswerVocabulary, writers map[domain.AnswerHolder]AnswerWriter) {
	s.vocabulary, s.answers = vocabulary, writers
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name: s.writeVerb("add_to_answer"),
		Description: "Write the next block of your answer. The answer is a document the reader keeps: each call appends one finished block of it, " +
			"in order, exactly as you write it — never commentary on your work, a progress note, or a remark about the task. " +
			"Once you have called this tool, your final message is not shown to anyone: the blocks you added are the whole answer. " +
			"Call describe_answer first: it lists the content types THIS answer takes, with each one's attrs and an example; " +
			"attrs is the block's map. A content type this answer does not take is refused with the reason and the ones it does.",
	}, s.addToAnswer)
	mcpsdk.AddTool(s.sdk, &mcpsdk.Tool{
		Name:        s.writeVerb("describe_answer"),
		Description: "List the content types this answer is written in with add_to_answer: for each, when to use it, the attrs its map takes, a minimal example map, and which of its blocks wait on work after they land.",
	}, s.describeAnswer)
}

// readVerb records name as one of the server's read verbs, which any run may
// call, and returns it.
func (s *Server) readVerb(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readVerbs = append(s.readVerbs, name)
	return name
}

// writeVerb records name as one of the server's write verbs, which only a run
// that may write may call, and returns it. A write verb refuses any other run
// itself (runGrant.refuseWrite).
func (s *Server) writeVerb(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeVerbs = append(s.writeVerbs, name)
	return name
}

// Verbs returns the names of the verbs a run may call: the read verbs, and the
// write verbs when writes is true.
func (s *Server) Verbs(writes bool) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]string(nil), s.readVerbs...)
	if writes {
		out = append(out, s.writeVerbs...)
	}
	return out
}

// SetBaseURL records the origin the CLI subprocess reaches the app on (the
// standalone localhost listener bound in main). Called after startup, when the
// port is known; safe to call again on library switch.
func (s *Server) SetBaseURL(base string) {
	s.mu.Lock()
	s.baseURL = strings.TrimRight(base, "/")
	s.mu.Unlock()
}

// EndpointFor issues a per-run bearer token bound to ex, registers it, and
// returns the /mcp URL + token to inject into the containment profile and the
// verbs the run may call (Verbs), so fetch_page keeps a page only in ex's
// container and add_to_answer writes only ex's answer; an empty ex grants
// neither. When writes is false the token refuses the write verbs whatever ex
// is. An empty URL (no listener yet) means no server is reachable, so the
// profile renders without MCP flags. The token is valid until EndRun ends its
// run. Implements ai.MCPEndpoint.
func (s *Server) EndpointFor(ex domain.Exchange, writes bool) (url, token string, verbs []string) {
	s.mu.RLock()
	base := s.baseURL
	s.mu.RUnlock()
	if base == "" {
		return "", "", nil
	}
	tok := s.issueToken(ex, writes)
	return base + "/mcp", tok, s.Verbs(writes)
}

// EndRun revokes token, so a request bearing it is refused as unauthorised and
// an add_to_answer already in flight on it writes nothing, and returns how many
// elements of its exchange's answer the run wrote. A token that is unknown or
// already ended wrote none. Implements ai.MCPEndpoint.
func (s *Server) EndRun(token string) (written int) {
	s.mu.Lock()
	g, ok := s.tokens[token]
	delete(s.tokens, token)
	s.mu.Unlock()
	if !ok {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.ended = true
	return g.written
}

func (s *Server) issueToken(ex domain.Exchange, writes bool) string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		logger.Error("sieve mcp: token generation failed", "err", err)
		return ""
	}
	tok := hex.EncodeToString(buf)
	ex.Container, ex.Block = strings.TrimSpace(ex.Container), strings.TrimSpace(ex.Block)
	s.mu.Lock()
	s.tokens[tok] = &runGrant{exchange: ex, writes: writes}
	s.mu.Unlock()
	return tok
}

func (s *Server) grantOf(tok string) (*runGrant, bool) {
	if tok == "" {
		return nil, false
	}
	s.mu.RLock()
	g, ok := s.tokens[tok]
	s.mu.RUnlock()
	return g, ok
}

// ServeHTTP authenticates the request against the per-run bearer token registry,
// binds the token's grant into the request context, and delegates to the
// streamable MCP handler. Unauthenticated requests are rejected — only the CLI
// Sieve launched (holding the injected token) may reach the knowledge base.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g, ok := s.grantOf(s.bearerToken(r))
	if !ok {
		// A hit on the localhost MCP without a valid per-run token is security-
		// relevant (only the CLI Sieve launched should reach it) — surface it.
		logger.Warn("sieve mcp: unauthorized request rejected", "remote", r.RemoteAddr, "path", r.URL.Path)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.handler.ServeHTTP(w, r.WithContext(g.bind(r.Context())))
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
