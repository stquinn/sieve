package editor

import (
	"errors"
	"fmt"
	"io/fs"
	"strconv"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store"
)

// NotesSource is the Router's face on the library's documents.
//
// It offers and resolves every document, filed note or buffer: Search answers
// through DocumentService.Search, and Resolve dereferences any document
// DocumentService.LoadByUUID finds, at every grain.
type NotesSource struct {
	documents *services.DocumentService
}

// NewNotesSource builds the library source over the document service.
func NewNotesSource(documents *services.DocumentService) *NotesSource {
	return &NotesSource{documents: documents}
}

// Name identifies this source in Router diagnostics.
func (s *NotesSource) Name() string { return "notes" }

// Search offers the documents matching criteria. A store that cannot be listed
// offers nothing.
func (s *NotesSource) Search(criteria domain.SearchCriteria) []domain.Candidate {
	hits, err := s.documents.Search(criteria)
	if err != nil {
		logger.Warn("notes source: search failed", "err", err)
		return nil
	}
	return hits
}

// Resolve dereferences an address into the document it names, or into the leaf
// it names inside one — live, or as of the version it pins. Anything this source
// does not hold — a deleted document, a version nobody wrote, a name the
// container does not answer to — is domain.ErrNodeNotFound, which the Router
// reads as "ask the next source".
func (s *NotesSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	doc, err := s.documents.LoadByUUID(addr.Container)
	if err != nil {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s: %v", domain.ErrNodeNotFound, addr.String(), err)
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

// nodeOf projects a loaded document into the kind-agnostic NodeDescriptor shape over
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
		ID:      doc.UUID(),
		Kind:    string(doc.Kind()),
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
