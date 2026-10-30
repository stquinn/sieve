package mcp

import (
	"context"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	searchDefaultLimit = 20
	searchMaxLimit     = 50
)

// ── Verb I/O types ────────────────────────────────────────────────────────────
//
// Input types drive the SDK-inferred JSON schema (jsonschema tags become field
// descriptions; fields without omitempty are required). Output types are the
// structured content returned to the model. NO path args ever — all scalars.

// SearchInput is the argument set for search.
type SearchInput struct {
	Query  string `json:"query" jsonschema:"the search text; matched case-insensitively against note titles, summaries and tags"`
	Folder string `json:"folder,omitempty" jsonschema:"optional folder path to restrict results (e.g. projects/go)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"maximum results to return (default 20, max 50)"`
}

// UUIDInput is the argument set for get_meta and get_note.
type UUIDInput struct {
	UUID string `json:"uuid" jsonschema:"the note's uuid — a bare uuid, never a sieve:// uri (pass one of those to get_by_uri instead)"`
}

// URIInput is the argument set for get_by_uri: a Sieve coordinate, copied
// verbatim from wherever the model was given it.
type URIInput struct {
	URI string `json:"uri" jsonschema:"a Sieve coordinate, e.g. sieve://{uuid}; copy it exactly as it was given (an attachment manifest lists them) rather than constructing one"`
}

// FetchPageInput is the argument set for fetch_page.
type FetchPageInput struct {
	URL string `json:"url" jsonschema:"the http or https URL of the web page to fetch and store as a markdown asset in the job's document"`
}


// NoteSummary is one search hit: metadata only, never a body.
type NoteSummary struct {
	UUID     string   `json:"uuid"`
	Title    string   `json:"title"`
	Folder   string   `json:"folder"`
	Tags     []string `json:"tags"`
	Summary  string   `json:"summary"`
	Modified string   `json:"modified"`
}

// SearchResults wraps the hit list; Truncated flags that limit capped the scan.
type SearchResults struct {
	Results   []NoteSummary `json:"results"`
	Truncated bool          `json:"truncated"`
}

// NoteMeta is the full distilled metadata for one note. No body.
type NoteMeta struct {
	UUID           string   `json:"uuid"`
	Title          string   `json:"title"`
	Folder         string   `json:"folder"`
	Filename       string   `json:"filename"`
	Tags           []string `json:"tags"`
	Summary        string   `json:"summary"`
	Created        string   `json:"created"`
	Modified       string   `json:"modified"`
	Version        int      `json:"version"`
	AiEval         string   `json:"ai_eval"`
	DensitySignals []string `json:"density_signals"`
}

// NoteContent is metadata plus the markdown body, as get_note returns it.
type NoteContent struct {
	Meta NoteMeta `json:"meta"`
	Body string   `json:"body"`
}

// NodeContent is what an address resolved to, as get_by_uri returns it: the
// wire projection of domain.NodeDescriptor. It is kind-AGNOSTIC — it says what
// the thing calls itself rather than assuming a note.
type NodeContent struct {
	URI     string `json:"uri"`  // the coordinate it was resolved from
	ID      string `json:"id"`   // the target's identity; for an asset, its key
	Kind    string `json:"kind"` // the source's own noun, e.g. "note"
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Body    string `json:"body"`            // empty for an asset
	Path    string `json:"path,omitempty"`  // an asset's bytes, relative to the library root
	Bytes   int    `json:"bytes,omitempty"` // an asset's size
}

// FolderFacet / TagFacet / Facets are the orientation view.
type FolderFacet struct {
	Name      string `json:"name"`
	NoteCount int    `json:"note_count"`
}

type TagFacet struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type Facets struct {
	Folders []FolderFacet `json:"folders"`
	Tags    []TagFacet    `json:"tags"`
}

// ── Verb handlers (transport-agnostic methods over the services) ──────────────

// search scans the library, naive-substring-matches the query against
// title/summary/tags, filters by folder, and caps at limit. Metadata only.
//
// V1 SCOPE / KNOWN LIMITATIONS (accepted for now; long-term not ideal):
//   - METADATA ONLY, never body — search leans entirely on AI-generated
//     summaries/tags, so a note whose body says the thing but whose metadata
//     doesn't will not surface. Bodies come only from the two body-bearing
//     verbs (get_note, get_by_uri), never from a search.
//   - FILED NOTES ONLY (LibraryCategory) — buffers are excluded, and they carry
//     no metadata anyway, so they'd be unfindable by a metadata match even if
//     included. The AI can still reach the active buffer as direct context and
//     read buffer files via the library --add-dir grant.
//
// The long-term fix for both is a real full-text index (#37): body-aware search
// that can also span buffers, replacing this metadata-only, notes-only scan.
func (s *Server) search(_ context.Context, _ *mcpsdk.CallToolRequest, in SearchInput) (*mcpsdk.CallToolResult, SearchResults, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = searchDefaultLimit
	}
	if limit > searchMaxLimit {
		limit = searchMaxLimit
	}

	notes, err := s.scan()
	if err != nil {
		return nil, SearchResults{}, err
	}

	q := strings.ToLower(strings.TrimSpace(in.Query))
	folder := strings.TrimSpace(in.Folder)

	out := SearchResults{Results: []NoteSummary{}}
	for _, n := range notes {
		if folder != "" && !s.folderMatchesReq(n.folder, folder) {
			continue
		}
		if q != "" && !s.matches(n, q) {
			continue
		}
		if len(out.Results) >= limit {
			out.Truncated = true
			break
		}
		out.Results = append(out.Results, s.summaryOf(n))
	}
	logger.Info("sieve mcp: search", "query", in.Query, "folder", folder, "results", len(out.Results), "truncated", out.Truncated)
	return nil, out, nil
}

// getMeta returns the full metadata for one note. No body.
func (s *Server) getMeta(_ context.Context, _ *mcpsdk.CallToolRequest, in UUIDInput) (*mcpsdk.CallToolResult, NoteMeta, error) {
	doc, err := s.documents.LoadByUUID(strings.TrimSpace(in.UUID))
	if err != nil {
		logger.Warn("sieve mcp: get_meta not found", "uuid", in.UUID, "err", err)
		return nil, NoteMeta{}, s.notADocument("get_meta", in.UUID, err)
	}
	meta := s.metaOf(scannedNote{uuid: doc.UUID(), folder: s.folderOf(doc), doc: doc})
	logger.Info("sieve mcp: get_meta", "uuid", in.UUID, "title", meta.Title)
	return nil, meta, nil
}

// getNote returns metadata plus the markdown body for a note named by uuid — one
// of the two body-bearing verbs. Every read it performs is recorded as a
// bodyRead, which is what keeps bulk-read auditable at one boundary.
func (s *Server) getNote(_ context.Context, _ *mcpsdk.CallToolRequest, in UUIDInput) (*mcpsdk.CallToolResult, NoteContent, error) {
	uuid := strings.TrimSpace(in.UUID)
	doc, err := s.documents.LoadByUUID(uuid)
	if err != nil {
		logger.Warn("sieve mcp: get_note not found", "uuid", in.UUID, "err", err)
		return nil, NoteContent{}, s.notADocument("get_note", uuid, err)
	}
	n := scannedNote{uuid: doc.UUID(), folder: s.folderOf(doc), doc: doc}
	body := string(doc.Body())
	meta := s.metaOf(n)
	// The audit names the document that was ACTUALLY read (doc.UUID()), not the
	// string that was asked for, so the trail cannot be skewed by a sloppy arg.
	s.audit.record(bodyRead{
		verb:      "get_note",
		container: n.uuid,
		id:        n.uuid,
		uri:       domain.NewContainerAddress(n.uuid).String(),
		title:     meta.Title,
		bytes:     len(body),
	})
	return nil, NoteContent{Meta: meta, Body: body}, nil
}

// notADocument is the error a by-uuid verb returns when the id loads no
// document. It names the verb that does reach a block or a file, because the id
// a model passes in that case is usually one of those.
func (s *Server) notADocument(verb, id string, err error) error {
	return fmt.Errorf("%s: %q is not a document (%w); a block or file inside a document is read with get_by_uri, passing the sieve:// uri its context gives", verb, id, err)
}

// getByURI is the Router exposed as a tool: it dereferences a Sieve coordinate
// and returns what that address names, body included — the second body-bearing
// verb, audited identically to get_note.
//
// It PARSES at its own door and checks nothing else. The uri arrives in a model's
// prompt, so the parse is where untrusted input stops being text, and it is what
// makes this verb structurally incapable of fetching an https address. Everything
// past the parse — version pins, leaf grains, dangling targets — is the Router's
// judgement; refusals are surfaced as tool errors naming the verb and the
// reason.
func (s *Server) getByURI(_ context.Context, _ *mcpsdk.CallToolRequest, in URIInput) (*mcpsdk.CallToolResult, NodeContent, error) {
	uri := strings.TrimSpace(in.URI)
	if s.nodes == nil {
		logger.Error("sieve mcp: get_by_uri has no resolver wired", "uri", uri)
		return nil, NodeContent{}, fmt.Errorf("get_by_uri %q: no resolver is wired", uri)
	}
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		logger.Warn("sieve mcp: get_by_uri refused", "uri", uri, "err", err)
		return nil, NodeContent{}, fmt.Errorf("get_by_uri %q: not a Sieve coordinate (expected sieve://{container}[/{leaf}][?version={n}]): %w", uri, err)
	}
	node, err := s.nodes.Resolve(addr)
	if err != nil {
		logger.Warn("sieve mcp: get_by_uri refused", "uri", uri, "err", err)
		return nil, NodeContent{}, fmt.Errorf("get_by_uri %q: %w", uri, err)
	}
	// The audit names BOTH grains: node.ID may be a leaf identity, so the
	// container must come off the ADDRESS this verb parsed, or the trail loses
	// which document a leaf read came out of.
	s.audit.record(bodyRead{
		verb:      "get_by_uri",
		container: addr.Container,
		id:        node.ID,
		uri:       node.URI,
		title:     node.Title,
		bytes:     len(node.Body),
	})
	return nil, NodeContent{
		URI:     node.URI,
		ID:      node.ID,
		Kind:    node.Kind,
		Title:   node.Title,
		Summary: node.Summary,
		Body:    node.Body,
		Path:    node.Path,
		Bytes:   node.Bytes,
	}, nil
}

// listFacets aggregates folders (with note counts) and tags (with counts) — the
// orientation call. One full scan.
func (s *Server) listFacets(_ context.Context, _ *mcpsdk.CallToolRequest, _ struct{}) (*mcpsdk.CallToolResult, Facets, error) {
	notes, err := s.scan()
	if err != nil {
		return nil, Facets{}, err
	}

	folderCounts := map[string]int{}
	tagCounts := map[string]int{}
	for _, n := range notes {
		if n.folder != "" {
			folderCounts[n.folder]++
		}
		for _, t := range n.doc.Meta().Tags() {
			if t = strings.TrimSpace(t); t != "" {
				tagCounts[t]++
			}
		}
	}

	out := Facets{Folders: []FolderFacet{}, Tags: []TagFacet{}}
	for name, c := range folderCounts {
		out.Folders = append(out.Folders, FolderFacet{Name: name, NoteCount: c})
	}
	for name, c := range tagCounts {
		out.Tags = append(out.Tags, TagFacet{Name: name, Count: c})
	}
	sort.Slice(out.Folders, func(i, j int) bool { return out.Folders[i].Name < out.Folders[j].Name })
	sort.Slice(out.Tags, func(i, j int) bool { return out.Tags[i].Name < out.Tags[j].Name })
	logger.Info("sieve mcp: list_facets", "folders", len(out.Folders), "tags", len(out.Tags))
	return nil, out, nil
}

// fetchPage retrieves an http or https URL, extracts its readable article as
// markdown via LinkPreviewService, and stores it as a URL-keyed asset in the
// calling job's document. A second call for the same URL in the same document
// reuses the stored asset without re-fetching.
//
// Writing is strictly bounded to the document bound to the caller's session
// context. Any retrieval or boundary failure returns a structured
// "cannot retrieve: {reason}" error so the AI can fall back to other tools.
func (s *Server) fetchPage(ctx context.Context, _ *mcpsdk.CallToolRequest, in FetchPageInput) (*mcpsdk.CallToolResult, NodeContent, error) {
	docUUID := DocumentFromContext(ctx)
	if docUUID == "" {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: no target document for this session")
	}
	rawURL := strings.TrimSpace(in.URL)
	if rawURL == "" {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: empty URL")
	}
	if s.documents == nil || s.nodes == nil {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: document store is not wired")
	}
	doc, err := s.documents.LoadByUUID(docUUID)
	if err != nil {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: document %q not found: %w", docUUID, err)
	}

	key := s.documents.PageAssetKey(rawURL)
	addr := domain.NewLeafAddress(doc.UUID(), key)

	for _, owned := range doc.Storable().Owns() {
		if owned.Key() == key {
			node, err := s.nodes.Resolve(addr)
			if err != nil {
				return nil, NodeContent{}, fmt.Errorf("cannot retrieve: %w", err)
			}
			title := s.headingTitle(string(owned.Body()))
			if title == "" {
				title = node.Title
			}
			return nil, NodeContent{
				URI:     node.URI,
				ID:      node.ID,
				Kind:    node.Kind,
				Title:   title,
				Summary: node.Summary,
				Body:    node.Body,
				Path:    node.Path,
				Bytes:   node.Bytes,
			}, nil
		}
	}

	lp := s.linkPreview
	if lp == nil {
		lp = services.NewLinkPreviewService()
	}
	page, err := lp.FetchReadable(rawURL, s.fetchTimeout)
	if err != nil {
		logger.Warn("sieve mcp: fetch_page refused", "url", rawURL, "doc", doc.UUID(), "err", err)
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: %w", err)
	}
	if _, err := s.documents.SaveAsset(doc, key, []byte(page.Markdown)); err != nil {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: save asset: %w", err)
	}
	node, err := s.nodes.Resolve(addr)
	if err != nil {
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: %w", err)
	}
	title := page.Title
	if title == "" {
		title = node.Title
	}
	logger.Info("sieve mcp: fetch_page", "url", rawURL, "doc", doc.UUID(), "asset", key, "bytes", node.Bytes)
	return nil, NodeContent{
		URI:     node.URI,
		ID:      node.ID,
		Kind:    node.Kind,
		Title:   title,
		Summary: node.Summary,
		Body:    node.Body,
		Path:    node.Path,
		Bytes:   node.Bytes,
	}, nil
}

func (s *Server) headingTitle(md string) string {
	for _, line := range strings.Split(md, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "# "))
		}
	}
	return ""
}

// ── Scan + projection helpers ─────────────────────────────────────────────────


// scannedNote is a loaded library note plus its derived folder path.
type scannedNote struct {
	uuid   string
	folder string
	doc    domain.Document
}

// scan enumerates every library note and loads each one's metadata.
//
// STOPGAP (#37): this is an O(n) full-load scan — DocumentService.List() already
// walks the store, then every note is re-loaded via LoadByUUID for its meta.
// Acceptable while the materialized metadata index (#37) is not yet built; the
// verbs will read that index directly once it lands.
func (s *Server) scan() ([]scannedNote, error) {
	entries, err := s.documents.List()
	if err != nil {
		return nil, err
	}
	var notes []scannedNote
	s.collect(entries, &notes)
	logger.Info("sieve mcp: full-load scan (stopgap, #37 index pending)", "notes", len(notes))
	return notes, nil
}

// collect flattens the library tree, loading each note's document. The folder is
// derived from the document's external ref so it is uniform with the single-note
// verbs (get_meta/get_note).
func (s *Server) collect(entries []services.NoteEntry, out *[]scannedNote) {
	for _, e := range entries {
		if e.IsDir {
			s.collect(e.Children, out)
			continue
		}
		doc, err := s.documents.LoadByUUID(e.ID)
		if err != nil {
			logger.Warn("sieve mcp: skip unreadable note", "id", e.ID, "err", err)
			continue
		}
		*out = append(*out, scannedNote{uuid: e.ID, folder: s.folderOf(doc), doc: doc})
	}
}

// matches reports whether q (already lowercased) substring-matches the note's
// title, summary or any tag.
func (s *Server) matches(n scannedNote, q string) bool {
	meta := n.doc.Meta()
	if strings.Contains(strings.ToLower(meta.DisplayName()), q) {
		return true
	}
	if sum := meta.Summary(); sum != nil && strings.Contains(strings.ToLower(*sum), q) {
		return true
	}
	for _, t := range meta.Tags() {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

func (s *Server) summaryOf(n scannedNote) NoteSummary {
	meta := n.doc.Meta()
	return NoteSummary{
		UUID:     n.uuid,
		Title:    meta.DisplayName(),
		Folder:   n.folder,
		Tags:     s.tagsOrEmpty(meta.Tags()),
		Summary:  s.strVal(meta.Summary()),
		Modified: s.timeStr(meta.Modified()),
	}
}

func (s *Server) metaOf(n scannedNote) NoteMeta {
	meta := n.doc.Meta()
	return NoteMeta{
		UUID:           n.uuid,
		Title:          meta.DisplayName(),
		Folder:         n.folder,
		Filename:       s.strVal(meta.Filename()),
		Tags:           s.tagsOrEmpty(meta.Tags()),
		Summary:        s.strVal(meta.Summary()),
		Created:        s.timeStr(meta.Created()),
		Modified:       s.timeStr(meta.Modified()),
		Version:        meta.Version(),
		AiEval:         meta.AiEval(),
		DensitySignals: s.tagsOrEmpty(meta.DensitySignals()),
	}
}

// folderOf derives a note's folder path from its store external ref by stripping
// the leading category-key segment (e.g. "store/") and taking the parent dir.
// A note at the library root returns "".
func (s *Server) folderOf(doc domain.Document) string {
	ref := filepath.ToSlash(doc.Storable().ExternalRef())
	if i := strings.IndexByte(ref, '/'); i >= 0 {
		ref = ref[i+1:] // drop the category key ("store/")
	}
	if dir := path.Dir(ref); dir != "." && dir != "/" && dir != "" {
		return dir
	}
	return ""
}

// folderMatches reports whether noteFolder is the requested folder or nested
// beneath it (case-insensitive).
func (s *Server) folderMatchesReq(noteFolder, want string) bool {
	nf := strings.ToLower(noteFolder)
	w := strings.ToLower(strings.Trim(want, "/"))
	return nf == w || strings.HasPrefix(nf, w+"/")
}

func (s *Server) strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Server) tagsOrEmpty(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// timeStr formats a timestamp as RFC3339, or "" for the zero value.
func (s *Server) timeStr(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
