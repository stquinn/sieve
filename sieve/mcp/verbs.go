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
	UUID string `json:"uuid" jsonschema:"the note's uuid"`
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

// NoteContent is metadata plus the markdown body — the only content-bearing verb.
type NoteContent struct {
	Meta NoteMeta `json:"meta"`
	Body string   `json:"body"`
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
			logger.Info("sieve mcp: search truncated", "limit", limit, "query", in.Query)
			break
		}
		out.Results = append(out.Results, s.summaryOf(n))
	}
	return nil, out, nil
}

// getMeta returns the full metadata for one note. No body.
func (s *Server) getMeta(_ context.Context, _ *mcpsdk.CallToolRequest, in UUIDInput) (*mcpsdk.CallToolResult, NoteMeta, error) {
	doc, err := s.documents.LoadByUUID(strings.TrimSpace(in.UUID))
	if err != nil {
		return nil, NoteMeta{}, fmt.Errorf("get_meta: %w", err)
	}
	return nil, s.metaOf(scannedNote{uuid: doc.UUID(), folder: s.folderOf(doc), doc: doc}), nil
}

// getNote returns metadata plus the markdown body — the visible bulk-read verb.
func (s *Server) getNote(_ context.Context, _ *mcpsdk.CallToolRequest, in UUIDInput) (*mcpsdk.CallToolResult, NoteContent, error) {
	doc, err := s.documents.LoadByUUID(strings.TrimSpace(in.UUID))
	if err != nil {
		return nil, NoteContent{}, fmt.Errorf("get_note: %w", err)
	}
	n := scannedNote{uuid: doc.UUID(), folder: s.folderOf(doc), doc: doc}
	return nil, NoteContent{Meta: s.metaOf(n), Body: string(doc.Body())}, nil
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
	return nil, out, nil
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
