package editor

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store"
)

// NotesSource is the Router's face on the library: filed documents, offered as
// candidates and resolved as Nodes.
//
// NOTES ONLY. An unfiled buffer is never offered (Search enumerates the library)
// and never resolved (Resolve refuses a non-note), even though
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

// Search offers the filed notes matching query, capped at limit, through
// DocumentService.Search (title, summary, tags and body). Results come back in
// library scan order, NOT relevance order.
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

// Resolve dereferences an address into the note it names, or into the leaf it
// names inside one — live, or as of the version it pins. Anything this source
// does not hold — a deleted document, an unfiled buffer, a version nobody wrote,
// a name the container does not answer to — is domain.ErrNodeNotFound, which the
// Router reads as "ask the next source".
func (s *NotesSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	uri := addr.String()
	doc, err := s.documents.LoadByUUID(addr.Container)
	if err != nil {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
	}
	if doc.Kind() != domain.KindNote {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s is not a filed note", domain.ErrNodeNotFound, uri)
	}
	// The pin names a CONTAINER version, so it is read — and dangles when nobody
	// wrote it — whatever grain the address goes on to name.
	body, err := s.bodyOf(addr, doc)
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	if addr.IsContainer() {
		return s.nodeOf(addr, doc, body), nil
	}
	leaves, err := newContainerLeaves(addr, doc, body)
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	return leaves.resolve()
}

// nodeOf projects a loaded note into the kind-agnostic NodeDescriptor shape over
// the body the address named.
//
// A pinned descriptor is NOT uniformly historical: the body is the snapshot,
// while title and summary are current, because snapshots are body-only.
func (s *NotesSource) nodeOf(addr domain.Address, doc domain.Document, body string) domain.NodeDescriptor {
	meta := doc.Meta()
	summary := ""
	if sm := meta.Summary(); sm != nil {
		summary = *sm
	}
	return domain.NodeDescriptor{
		URI:     addr.String(),
		UUID:    doc.UUID(),
		Kind:    string(domain.KindNote),
		Title:   meta.DisplayName(),
		Summary: summary,
		Body:    body,
	}
}

// bodyOf reads the container content an address names: today's, or the snapshot
// it pins.
func (s *NotesSource) bodyOf(addr domain.Address, doc domain.Document) (string, error) {
	if !addr.IsPinned() {
		return string(doc.Body()), nil
	}
	snapshot, err := s.documents.RetrieveVersion(doc, store.VersionRef{ID: strconv.Itoa(addr.Version)})
	if err != nil {
		// A version nobody wrote, or one pruned out of history, is dangling; the
		// store reports it as a missing snapshot file. Every other failure must
		// surface, or a broken store reads as a deleted snapshot.
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("%w: %s", domain.ErrNodeNotFound, addr.String())
		}
		return "", err
	}
	return string(snapshot.Body), nil
}

// candidateOf projects a search hit into an offer. Summary is the NOTE's own
// one-liner, so a reference minted from an accepted mention is born complete and
// never resolves merely to render. Detail is a different sentence; see
// domain.Candidate.
func (s *NotesSource) candidateOf(r services.SearchResult) domain.Candidate {
	return domain.Candidate{
		URI:     domain.NewContainerAddress(r.ID).String(),
		Title:   r.Name,
		Kind:    string(domain.KindNote),
		Detail:  s.detailOf(r),
		Summary: r.Summary,
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
