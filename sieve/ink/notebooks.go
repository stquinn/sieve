package ink

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
)

// ContainerNodes describes a block container already loaded as the Router describes any block
// container, at container grain and at a leaf. editor.BlockSource implements it.
type ContainerNodes interface {
	Node(addr domain.Address, c *domain.BlockContainer) (domain.NodeDescriptor, error)
}

// Notebooks is the Router's source for the Digital Notes this Sieve holds. Search offers them as
// InkService.searchNotebooks finds them. Resolve answers an address in a Digital Note's container
// as nodes describes it, with the container's own summary at container grain; any other container,
// and anything that is not a block container, is domain.ErrNodeNotFound.
type Notebooks struct {
	svc   *InkService
	nodes ContainerNodes
}

// NewNotebooks is the source of svc's Digital Notes, described through nodes.
func NewNotebooks(svc *InkService, nodes ContainerNodes) *Notebooks {
	return &Notebooks{svc: svc, nodes: nodes}
}

// Name identifies this source in Router diagnostics.
func (n *Notebooks) Name() string { return "notebooks" }

// Search offers the Digital Notes matching c.
func (n *Notebooks) Search(c domain.SearchCriteria) []domain.Candidate {
	return n.svc.searchNotebooks(c)
}

// Resolve dereferences an address in a Digital Note's container.
func (n *Notebooks) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	c, err := n.svc.containers.Load(addr.Container)
	if errors.Is(err, domain.ErrNotBlockContainer) {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s: %v", domain.ErrNodeNotFound, addr.String(), err)
	}
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	if c.Kind() != KindDigitalNote {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s is a %s", domain.ErrNodeNotFound, addr.String(), c.Kind())
	}
	node, err := n.nodes.Node(addr, c)
	if err != nil || !addr.IsContainer() {
		return node, err
	}
	kind, meta := NewDigitalNoteKind(), c.Storable().Meta()
	node.Title, node.Summary = kind.Called(meta, c.Block().StringAttr("title")), kind.searched(meta).summary
	return node, nil
}

// searchNotebooks is every Digital Note held that c asks for, ordered by name: matched on its
// name (DigitalNoteKind.Called), its summary, and its keywords and categories as its tags, read
// from its .meta alone; CONTENT finds nothing in a notebook. A notebook is durable and has no
// folder, so none is offered when c gives a folder.
func (s *InkService) searchNotebooks(c domain.SearchCriteria) []domain.Candidate {
	if !c.Includes(KindDigitalNote, true) || !c.InFolder("") {
		return nil
	}
	found, err := s.containers.Find(KindDigitalNote, nil)
	if err != nil {
		logger.Warn("ink: searching notebooks", "err", err.Error())
		return nil
	}
	var out []domain.Candidate
	kind := NewDigitalNoteKind()
	for uuid, meta := range found {
		face := kind.searched(meta)
		matched, ok := c.Match(map[domain.SearchField][]string{
			domain.SearchName: {face.name}, domain.SearchSummary: {face.summary}, domain.SearchTags: face.tags,
		})
		if !ok {
			continue
		}
		out = append(out, domain.Candidate{
			URI: domain.NewContainerAddress(uuid).String(), Title: face.name, Kind: KindDigitalNote,
			Detail: meta["note_device"], Summary: face.summary, Tags: face.tags, Modified: face.modified, Matched: matched,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Title != out[j].Title {
			return out[i].Title < out[j].Title
		}
		return out[i].URI < out[j].URI
	})
	if c.Limit > 0 && len(out) > c.Limit {
		out = out[:c.Limit]
	}
	return out
}

// searchedFace is a Digital Note as a search reads it from its .meta.
type searchedFace struct {
	name, summary string
	// tags are its keywords, then its categories.
	tags []string
	// modified is when its .meta says it last changed, RFC 3339; "" when it does not say.
	modified string
}

// searched is the Digital Note whose .meta is meta, as a search reads it.
func (k DigitalNoteKind) searched(meta map[string]string) searchedFace {
	d, _, _ := k.Description(meta)
	face := searchedFace{name: k.Called(meta, meta["note_title"]), summary: strings.TrimSpace(d.Summary)}
	face.tags = append(append(face.tags, d.Keywords...), d.Categories...)
	if t := domain.NewDocumentMeta(meta, nil).Modified(); !t.IsZero() {
		face.modified = t.Format(time.RFC3339)
	}
	return face
}
