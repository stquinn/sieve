package mcp

import (
	"bytes"
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
	"golang.org/x/net/html"
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
	Query  string `json:"query" jsonschema:"the search text; matched case-insensitively against names, summaries and tags, never bodies; empty lists everything"`
	Folder string `json:"folder,omitempty" jsonschema:"optional folder path to restrict results to filed notes in it or beneath it (e.g. projects/go)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"maximum results to return (default 20, max 50)"`
}

// URIInput is the argument set for get_meta, get_note and get_by_uri: a
// sieve:// address.
type URIInput struct {
	URI string `json:"uri" jsonschema:"a sieve:// address: sieve://{container} for a note or other container, sieve://{container}/{leaf} for a block or file inside one"`
}

// FetchPageInput is the argument set for fetch_page.
type FetchPageInput struct {
	URL string `json:"url" jsonschema:"the http or https URL of the web page to fetch and store as an HTML asset in the job's document"`
}

// AddToAnswerInput is the argument set for add_to_answer. It names no target:
// the run's token is bound to the exchange it answers.
type AddToAnswerInput struct {
	ContentType string         `json:"content_type" jsonschema:"the block's content type, e.g. sieve/prose; describe_answer lists them"`
	Attrs       map[string]any `json:"attrs" jsonschema:"the block's map of attrs, e.g. {\"content\": \"…markdown…\"} for sieve/prose; describe_answer gives each type's attrs and an example"`
}

// AnswerAdded is what add_to_answer reports: the content type of the block just
// added and how many blocks the answer now holds from this run.
type AnswerAdded struct {
	Added  string `json:"added"`
	Blocks int    `json:"blocks"`
}

// AnswerCatalogue is what describe_answer returns: every content type this
// run's answer can be written in, and what else its holder says of it.
type AnswerCatalogue struct {
	ContentTypes []domain.AnswerCard `json:"content_types"`
	Note         string              `json:"note,omitempty"`
}

// NoteSummary is one search hit: metadata only, never a body.
//
// Kind is the source's own noun: "note" for a filed note, "buffer" for an
// unfiled one, "digital-note" for a notebook written on a SieveInk device, and
// "ink-live" for the Live view while it exists. Only a note has a folder; a
// notebook carries its own summary and keywords as Summary and Tags, and the
// Live view only a title.
type NoteSummary struct {
	URI      string   `json:"uri"` // the hit's absolute sieve:// address, to pass to any verb that takes one
	Kind     string   `json:"kind"`
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
	URI            string   `json:"uri"` // the note's absolute sieve:// address
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
	URI     string `json:"uri"`  // the address it was resolved from
	Kind    string `json:"kind"` // the source's own noun, e.g. "note"
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Body    string `json:"body"`            // empty for an asset
	Path    string `json:"path,omitempty"`  // an asset's bytes, relative to the library root
	Bytes   int    `json:"bytes,omitempty"` // an asset's size
	// Assets lists what a whole container owns, each fetchable by its uri;
	// absent at leaf grain and for a container that owns none.
	Assets []domain.NodeAsset `json:"assets,omitempty"`
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

// search asks the search service for everything whose name, summary or tags
// hold the query, in the folder given, capped at limit. Metadata only: bodies
// come only from the two body-bearing verbs (get_note, get_by_uri), never from a
// search.
func (s *Server) search(_ context.Context, _ *mcpsdk.CallToolRequest, in SearchInput) (*mcpsdk.CallToolResult, SearchResults, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = searchDefaultLimit
	}
	if limit > searchMaxLimit {
		limit = searchMaxLimit
	}
	if s.finder == nil {
		return nil, SearchResults{}, fmt.Errorf("search: no search service is wired")
	}
	out := SearchResults{Results: []NoteSummary{}}
	folder := strings.TrimSpace(in.Folder)
	// One more than the limit is asked for, so a cut can be told from an exact fit.
	hits := s.finder.Search(domain.SearchCriteria{
		Terms:  in.Query,
		Fields: domain.SearchFields{domain.SearchName, domain.SearchSummary, domain.SearchTags},
		Folder: folder,
		Limit:  limit + 1,
	})
	if len(hits) > limit {
		hits, out.Truncated = hits[:limit], true
	}
	for _, hit := range hits {
		out.Results = append(out.Results, s.summaryOf(hit))
	}
	logger.Info("sieve mcp: search", "query", in.Query, "folder", folder, "results", len(out.Results), "truncated", out.Truncated)
	return nil, out, nil
}

// getMeta returns the full metadata for the note an address names. No body.
func (s *Server) getMeta(_ context.Context, _ *mcpsdk.CallToolRequest, in URIInput) (*mcpsdk.CallToolResult, NoteMeta, error) {
	addr, err := s.noteAddress("get_meta", in.URI)
	if err != nil {
		logger.Warn("sieve mcp: get_meta refused", "uri", in.URI, "err", err)
		return nil, NoteMeta{}, err
	}
	doc, err := s.documents.LoadByUUID(addr.Container)
	if err != nil {
		logger.Warn("sieve mcp: get_meta not found", "uri", in.URI, "err", err)
		return nil, NoteMeta{}, s.notADocument("get_meta", in.URI, err)
	}
	meta := s.metaOf(scannedNote{uuid: doc.UUID(), folder: s.folderOf(doc), doc: doc})
	logger.Info("sieve mcp: get_meta", "uri", in.URI, "title", meta.Title)
	return nil, meta, nil
}

// getNote returns metadata plus the markdown body for the note an address
// names — one of the two body-bearing verbs. Every read it performs is recorded
// as a bodyRead, which is what keeps bulk-read auditable at one boundary.
func (s *Server) getNote(_ context.Context, _ *mcpsdk.CallToolRequest, in URIInput) (*mcpsdk.CallToolResult, NoteContent, error) {
	addr, err := s.noteAddress("get_note", in.URI)
	if err != nil {
		logger.Warn("sieve mcp: get_note refused", "uri", in.URI, "err", err)
		return nil, NoteContent{}, err
	}
	doc, err := s.documents.LoadByUUID(addr.Container)
	if err != nil {
		logger.Warn("sieve mcp: get_note not found", "uri", in.URI, "err", err)
		return nil, NoteContent{}, s.notADocument("get_note", in.URI, err)
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

// addressOf is what a verb makes of its argument: the sieve:// address it
// spells. Anything else, a bare uuid or a web address included, is
// domain.ErrBadAddress, so the parse is the verb's door for untrusted input.
func (s *Server) addressOf(verb, arg string) (domain.Address, error) {
	arg = strings.TrimSpace(arg)
	addr, err := domain.ParseAddress(arg)
	if err != nil {
		return domain.Address{}, fmt.Errorf("%s %q: not a Sieve address: a bare id is not an address; an address is sieve://{container} for a note or other container, or sieve://{container}/{leaf} for a block or file inside one: %w", verb, arg, err)
	}
	return addr, nil
}

// noteAddress is addressOf for a verb that reads a whole note: an address with
// a leaf or a version pin names something that verb does not read, and is
// refused with the verb that does.
func (s *Server) noteAddress(verb, arg string) (domain.Address, error) {
	addr, err := s.addressOf(verb, arg)
	if err != nil {
		return domain.Address{}, err
	}
	if !addr.IsContainer() || addr.IsPinned() {
		return domain.Address{}, fmt.Errorf("%s: %q names a leaf or a pinned version, not a whole note; read it with get_by_uri", verb, strings.TrimSpace(arg))
	}
	return addr, nil
}

// notADocument is the error a whole-note verb returns when the address names no
// note. It names the verb that does reach a block, a file or anything else an
// address can name.
func (s *Server) notADocument(verb, uri string, err error) error {
	return fmt.Errorf("%s: %q is not a note (%w); anything else a sieve:// address names is read with get_by_uri", verb, uri, err)
}

// getByURI is the Router exposed as a tool: it dereferences a Sieve coordinate
// and returns what that address names, body included — the second body-bearing
// verb, audited identically to get_note.
//
// It PARSES at its own door (addressOf) and checks nothing else. The argument
// arrives in a model's prompt, so the parse is where untrusted input stops being
// text, and it is what makes this verb structurally incapable of fetching an
// https address. Everything past the parse — version pins, leaf grains,
// dangling targets — is the Router's
// judgement; refusals are surfaced as tool errors naming the verb and the
// reason.
func (s *Server) getByURI(_ context.Context, _ *mcpsdk.CallToolRequest, in URIInput) (*mcpsdk.CallToolResult, NodeContent, error) {
	uri := strings.TrimSpace(in.URI)
	if s.nodes == nil {
		logger.Error("sieve mcp: get_by_uri has no resolver wired", "uri", uri)
		return nil, NodeContent{}, fmt.Errorf("get_by_uri %q: no resolver is wired", uri)
	}
	addr, err := s.addressOf("get_by_uri", uri)
	if err != nil {
		logger.Warn("sieve mcp: get_by_uri refused", "uri", uri, "err", err)
		return nil, NodeContent{}, err
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
		Kind:    node.Kind,
		Title:   node.Title,
		Summary: node.Summary,
		Body:    node.Body,
		Path:    node.Path,
		Bytes:   node.Bytes,
		Assets:  node.Assets,
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

// fetchPage retrieves an http or https URL, extracts its readable article as an
// HTML document via LinkPreviewService, and stores it as a URL-keyed asset in the
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
			title := s.htmlTitle(owned.Body())
			if title == "" {
				title = node.Title
			}
			return nil, NodeContent{
				URI:     node.URI,
				Kind:    node.Kind,
				Title:   title,
				Summary: node.Summary,
				Body:    node.Body,
				Path:    node.Path,
				Bytes:   node.Bytes,
			}, nil
		}
	}

	page, err := s.linkPreview.FetchReadable(rawURL, s.fetchTimeout)
	if err != nil {
		logger.Warn("sieve mcp: fetch_page refused", "url", rawURL, "doc", doc.UUID(), "err", err)
		return nil, NodeContent{}, fmt.Errorf("cannot retrieve: %w", err)
	}
	if _, err := s.documents.SaveAsset(doc, key, []byte(page.HTML)); err != nil {
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
		Kind:    node.Kind,
		Title:   title,
		Summary: node.Summary,
		Body:    node.Body,
		Path:    node.Path,
		Bytes:   node.Bytes,
	}, nil
}

// addToAnswer builds one block from the content type and attrs given and appends
// it to the answer of the exchange the caller's token is bound to. The run's
// first block replaces whatever answer an earlier run left. A content type this
// answer does not take, a refused build or a refused write returns the refusal
// as a tool error and writes nothing.
func (s *Server) addToAnswer(ctx context.Context, _ *mcpsdk.CallToolRequest, in AddToAnswerInput) (*mcpsdk.CallToolResult, AnswerAdded, error) {
	g, _ := ctx.Value(grantContextKey{}).(*runGrant)
	if err := g.refuseWrite("add_to_answer"); err != nil {
		return nil, AnswerAdded{}, err
	}
	if !g.exchange.Answers() {
		return nil, AnswerAdded{}, fmt.Errorf("add_to_answer: this run is not answering a question")
	}
	writer, ok := s.answers[g.exchange.Holder]
	if !ok {
		return nil, AnswerAdded{}, fmt.Errorf("add_to_answer: nothing here holds this answer; stop writing this answer")
	}
	el, err := s.admitted(g.exchange, writer.AnswerHolding(), in)
	if err != nil {
		logger.Warn("sieve mcp: add_to_answer refused", "container", g.exchange.Container, "block", g.exchange.Block, "holder", g.exchange.Holder, "content_type", in.ContentType, "err", err)
		return nil, AnswerAdded{}, fmt.Errorf("add_to_answer: %w", err)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ended {
		return nil, AnswerAdded{}, fmt.Errorf("add_to_answer: this run has ended; stop writing this answer")
	}
	if err := writer.AppendToAnswer(g.exchange, el, g.written == 0); err != nil {
		logger.Warn("sieve mcp: add_to_answer refused", "container", g.exchange.Container, "block", g.exchange.Block, "holder", g.exchange.Holder, "err", err)
		return nil, AnswerAdded{}, fmt.Errorf("add_to_answer: %w; stop writing this answer", err)
	}
	g.written++
	logger.Info("sieve mcp: add_to_answer", "container", g.exchange.Container, "block", g.exchange.Block, "holder", g.exchange.Holder, "kind", el.Kind, "blocks", g.written)
	return nil, AnswerAdded{Added: in.ContentType, Blocks: g.written}, nil
}

// admitted builds the block in describes for ex's answer when an answer held so
// takes it: a content type no kind offers, one the holding refuses, or a block
// as built that the holding refuses, is refused naming the content types it
// takes.
func (s *Server) admitted(ex domain.Exchange, holding domain.AnswerHolding, in AddToAnswerInput) (domain.SieveBlock, error) {
	var available []string
	for _, card := range holding.Offers(s.vocabulary.AnswerCards()) {
		available = append(available, card.ContentType)
	}
	card, known := s.cardOf(in.ContentType)
	if !known {
		return domain.SieveBlock{}, fmt.Errorf("%q is not a content type an answer can be written in. Available here: %s",
			in.ContentType, strings.Join(available, ", "))
	}
	if err := holding.Admit(card, card.WaitsAlways, available); err != nil {
		return domain.SieveBlock{}, err
	}
	el, err := s.vocabulary.BuildAnswerElement(ex.AnswerDocument(), in.ContentType, in.Attrs)
	if err != nil {
		return domain.SieveBlock{}, err
	}
	if err := holding.Admit(card, s.vocabulary.Waits(el), available); err != nil {
		return domain.SieveBlock{}, err
	}
	return el, nil
}

// cardOf is the card of contentType, when a kind offers it.
func (s *Server) cardOf(contentType string) (domain.AnswerCard, bool) {
	for _, card := range s.vocabulary.AnswerCards() {
		if card.ContentType == strings.TrimSpace(contentType) {
			return card, true
		}
	}
	return domain.AnswerCard{}, false
}

// describeAnswer lists the content types the caller's answer can be written in:
// those its holder takes, and what the holder says beyond them. A run that may
// not write is refused.
func (s *Server) describeAnswer(ctx context.Context, _ *mcpsdk.CallToolRequest, _ struct{}) (*mcpsdk.CallToolResult, AnswerCatalogue, error) {
	g, _ := ctx.Value(grantContextKey{}).(*runGrant)
	if err := g.refuseWrite("describe_answer"); err != nil {
		return nil, AnswerCatalogue{}, err
	}
	holding := domain.AnswerHolding{RunsJobs: true}
	if writer, ok := s.answers[g.exchange.Holder]; ok {
		holding = writer.AnswerHolding()
	}
	return nil, AnswerCatalogue{ContentTypes: holding.Offers(s.vocabulary.AnswerCards()), Note: holding.Note()}, nil
}

// htmlTitle returns the trimmed text of doc's first <title>, or empty when it
// has none.
func (s *Server) htmlTitle(doc []byte) string {
	z := html.NewTokenizer(bytes.NewReader(doc))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return ""
		case html.StartTagToken:
			if name, _ := z.TagName(); string(name) == "title" {
				if z.Next() == html.TextToken {
					return strings.TrimSpace(string(z.Text()))
				}
				return ""
			}
		}
	}
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

func (s *Server) summaryOf(hit domain.Candidate) NoteSummary {
	return NoteSummary{
		URI:      domain.NewContainerAddress(hit.Container()).String(),
		Kind:     hit.Kind,
		Title:    hit.Title,
		Folder:   hit.Folder,
		Tags:     s.tagsOrEmpty(hit.Tags),
		Summary:  hit.Summary,
		Modified: hit.Modified,
	}
}

func (s *Server) metaOf(n scannedNote) NoteMeta {
	meta := n.doc.Meta()
	return NoteMeta{
		URI:            domain.NewContainerAddress(n.uuid).String(),
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
