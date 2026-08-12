package editor

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// NotesSource is the Router's face on the library: filed documents, offered as
// candidates and resolved as Nodes.
//
// NOTES ONLY, deliberately. The source invariant is that it may only offer what
// the AI can dereference, and MCP get_note covers filed library documents and
// nothing else — so an unfiled buffer is never offered (Search enumerates the
// library) and never resolved (Resolve refuses a non-note), even though
// DocumentService.LoadByUUID would happily find one.
type NotesSource struct {
	documents *services.DocumentService
}

// NewNotesSource builds the library source over the document service.
func NewNotesSource(documents *services.DocumentService) *NotesSource {
	return &NotesSource{documents: documents}
}

// Name identifies this source in Router diagnostics.
func (s *NotesSource) Name() string { return "notes" }

// Search offers the filed notes matching query, capped at limit. It leans on
// DocumentService.Search, which matches title, summary, tags and body — the
// title half is what a name-keyed @ picker needs. Results come back in library
// scan order, not relevance order; ranking waits for the metadata index (#37).
func (s *NotesSource) Search(query string, limit int) []domain.Candidate {
	if limit <= 0 || strings.TrimSpace(query) == "" {
		return nil
	}
	results, err := s.documents.Search(query)
	if err != nil {
		logger.Warn("notes source: search failed", "query", query, "err", err)
		return nil
	}
	out := make([]domain.Candidate, 0, min(limit, len(results))) // limit is caller-supplied
	for _, r := range results {
		if len(out) >= limit {
			break
		}
		if !ident.Valid(r.ID) {
			continue // no uuid = no address that parses = not offerable
		}
		out = append(out, s.candidateOf(r))
	}
	return out
}

// Resolve dereferences a container address into the note it names. Anything this
// source does not hold — a foreign scheme, a deleted document, an unfiled buffer
// — is domain.ErrNodeNotFound, which the Router reads as "ask the next source".
func (s *NotesSource) Resolve(uri string) (domain.Node, error) {
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		return domain.Node{}, err
	}
	if addr.Scheme != domain.SchemeContainer {
		return domain.Node{}, fmt.Errorf("%w: notes does not answer scheme %q", domain.ErrNodeNotFound, addr.Scheme)
	}
	doc, err := s.documents.LoadByUUID(addr.Container)
	if err != nil {
		return domain.Node{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
	}
	if doc.Kind() != domain.KindNote {
		return domain.Node{}, fmt.Errorf("%w: %s is not a filed note", domain.ErrNodeNotFound, uri)
	}
	return s.nodeOf(addr, doc), nil
}

// nodeOf projects a loaded note into the kind-agnostic Node shape.
func (s *NotesSource) nodeOf(addr domain.Address, doc domain.Document) domain.Node {
	meta := doc.Meta()
	summary := ""
	if sm := meta.Summary(); sm != nil {
		summary = *sm
	}
	return domain.Node{
		URI:     addr.String(),
		UUID:    doc.UUID(),
		Kind:    string(domain.KindNote),
		Title:   meta.DisplayName(),
		Summary: summary,
		Body:    string(doc.Body()),
	}
}

// candidateOf projects a search hit into an offer.
func (s *NotesSource) candidateOf(r services.SearchResult) domain.Candidate {
	return domain.Candidate{
		URI:    domain.NewContainerAddress(r.ID).String(),
		Title:  r.Name,
		Kind:   string(domain.KindNote),
		Detail: s.detailOf(r),
	}
}

// detailOf builds the picker's disambiguation line: the folder first (two notes
// may legitimately share a title — the folder is what tells them apart), then
// whatever snippet the match produced.
func (s *NotesSource) detailOf(r services.SearchResult) string {
	var parts []string
	if folder := s.folderOf(r.Path); folder != "" {
		parts = append(parts, folder)
	}
	if snippet := strings.TrimSpace(r.Snippet); snippet != "" {
		parts = append(parts, snippet)
	}
	return strings.Join(parts, " · ")
}

// folderOf derives a note's folder path from its store external ref by stripping
// the leading category-key segment and taking the parent directory. A note at
// the library root has none.
func (s *NotesSource) folderOf(externalRef string) string {
	ref := filepath.ToSlash(externalRef)
	if i := strings.IndexByte(ref, '/'); i >= 0 {
		ref = ref[i+1:] // drop the category key ("store/")
	}
	if dir := path.Dir(ref); dir != "." && dir != "/" && dir != "" {
		return dir
	}
	return ""
}
