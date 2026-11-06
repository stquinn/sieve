package editor

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// newContainerEditor builds an editor that opens block containers, wired the way
// the composition root wires it, over one containerKind container. Filing goes
// to a counting filer on a real engine.
func newContainerEditor(t *testing.T) (*EditorService, *services.BlockContainerService, *domain.BlockContainer, *countingFiler) {
	t.Helper()
	containers, ds, _ := newTestContainers(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetContainers(containers)
	containers.SetChangeListener(es)
	es.SetEngine(services.NewJobEngine(map[string]int{"ai": 1}, 1, services.NewJobTracker()))
	filer := &countingFiler{seen: map[string]int{}}
	es.ai = filer
	t.Cleanup(es.CloseAll)

	c, err := containers.Create(containerKind, map[string]interface{}{"title": "a snippet", "source": "x := 1"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return es, containers, c, filer
}

func TestContainerSession_OpensItsOneBlockWithoutAShadow(t *testing.T) {
	es, _, c, _ := newContainerEditor(t)
	uuid := c.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if es.sessionFor(uuid) == nil || es.shadowFor(uuid) != nil {
		t.Fatalf("want a session with no shadow")
	}
	if got := es.openUUIDs(); len(got) != 0 {
		t.Errorf("openUUIDs = %v, want no documents", got)
	}
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok || len(blocks) != 1 || blocks[0].ID != uuid || blocks[0].Kind != containerKind || blocks[0].Attrs["source"] != "x := 1" {
		t.Fatalf("FrontendBlocks = %+v, %v; want the container's one block", blocks, ok)
	}

	es.Close(uuid)
	closed, err := es.Blocks(uuid)
	if err != nil || len(closed) != 1 || closed[0].ID != uuid {
		t.Errorf("Blocks of the closed container = %+v, %v", closed, err)
	}
	if err := es.Open(testMissingUUID); err == nil {
		t.Error("Open of a uuid naming nothing succeeded")
	}
}

// nodeResolver resolves one uuid, until it is gone, to a node of kind nodeKind with the attrs it
// holds; every other address is domain.ErrNodeNotFound.
type nodeResolver struct {
	uuid string

	mu    sync.Mutex
	attrs map[string]interface{}
	gone  bool
}

const nodeKind = "test-node"

func (r *nodeResolver) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if addr.Container != r.uuid || r.gone {
		return domain.NodeDescriptor{}, domain.ErrNodeNotFound
	}
	return domain.NodeDescriptor{ID: r.uuid, Kind: nodeKind, Attrs: r.attrs}, nil
}

func (r *nodeResolver) set(attrs map[string]interface{}, gone bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.attrs, r.gone = attrs, gone
}

// newNodeEditor builds an editor that opens block containers and the one node a nodeResolver
// resolves, wired as the composition root wires it.
func newNodeEditor(t *testing.T) (*EditorService, *nodeResolver) {
	t.Helper()
	es, _, _, _ := newContainerEditor(t)
	nodes := &nodeResolver{uuid: "019a0000-0000-7000-8000-00000000beef", attrs: map[string]interface{}{"page": "p1"}}
	es.SetNodes(nodes)
	return es, nodes
}

func TestNodeSession_OpensTheNodesOneBlockAndClosesWhenItNoLongerResolves(t *testing.T) {
	es, nodes := newNodeEditor(t)
	type pushed struct {
		blockID string
		attrs   map[string]interface{}
	}
	var got []pushed
	es.SetLifecycleListener(&mockLifecycleListener{onUpdated: func(_, blockID string, attrs map[string]interface{}) {
		got = append(got, pushed{blockID, attrs})
	}})
	if err := es.Open(nodes.uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	blocks, ok := es.FrontendBlocks(nodes.uuid)
	if !ok || len(blocks) != 1 || blocks[0].ID != nodes.uuid || blocks[0].Kind != nodeKind || blocks[0].Attrs["page"] != "p1" {
		t.Fatalf("FrontendBlocks = %+v, %v; want the node's one block", blocks, ok)
	}
	if es.shadowFor(nodes.uuid) != nil || len(es.openUUIDs()) != 0 {
		t.Error("a node opened as a document")
	}

	nodes.set(map[string]interface{}{"page": "p2"}, false)
	if err := es.Refresh(nodes.uuid); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(got) != 1 || got[0].blockID != nodes.uuid || got[0].attrs["page"] != "p2" {
		t.Fatalf("pushed %+v, want one attrs update carrying the node's new attrs", got)
	}
	if blocks, _ := es.FrontendBlocks(nodes.uuid); blocks[0].Attrs["page"] != "p2" {
		t.Errorf("the session still holds %v", blocks[0].Attrs["page"])
	}

	nodes.set(nil, true)
	if err := es.Refresh(nodes.uuid); err != nil {
		t.Fatalf("Refresh of a node gone: %v", err)
	}
	if es.sessionFor(nodes.uuid) != nil || len(got) != 1 {
		t.Errorf("a node that no longer resolves: session %v, pushed %+v", es.sessionFor(nodes.uuid), got)
	}
	if err := es.Open(nodes.uuid); err == nil {
		t.Error("Open of a node that no longer resolves succeeded")
	}
}

// A block container and a node are read-only sessions: every document verb refuses them, naming
// what they are, and leaves what they hold as it was.
func TestReadOnlySessions_RefuseEveryDocumentVerb(t *testing.T) {
	for _, session := range []struct {
		name, says string
		open       func(t *testing.T) (es *EditorService, uuid, kind string)
	}{
		{"block container", "is a block container", func(t *testing.T) (*EditorService, string, string) {
			es, _, c, _ := newContainerEditor(t)
			return es, c.UUID(), containerKind
		}},
		{"node", "is a " + nodeKind + " node", func(t *testing.T) (*EditorService, string, string) {
			es, nodes := newNodeEditor(t)
			return es, nodes.uuid, nodeKind
		}},
	} {
		t.Run(session.name, func(t *testing.T) {
			es, uuid, kind := session.open(t)
			if err := es.Open(uuid); err != nil {
				t.Fatalf("Open: %v", err)
			}
			before, _ := es.FrontendBlocks(uuid)
			entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "SELECT 1"}}

			for _, tc := range []struct {
				name string
				verb func() error
			}{
				{"create-block", func() error {
					return es.HandleBlockOp(uuid, block.BlockOp{Type: "create-block", Kind: kind})
				}},
				{"update-block", func() error {
					return es.HandleBlockOp(uuid, block.BlockOp{Type: "update-block", BlockID: uuid, Kind: kind, Attrs: map[string]interface{}{"source": "y"}})
				}},
				{"delete-block", func() error { return es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: uuid}) }},
				{"doc-update", func() error { return es.UpdateMarkdown(uuid, "# replaced") }},
				{"retry merge", func() error {
					return es.UpdateBlock(uuid, domain.SieveBlock{ID: uuid, Attrs: map[string]interface{}{"status": "PENDING"}})
				}},
				{"text-replace", func() error {
					return es.ReplaceText(uuid, domain.TextEdit{BlockID: uuid, Quote: "x", Grain: domain.GrainLiteral})
				}},
				{"export", func() error { _, err := es.Export(uuid, nil, block.MarkdownGenerator{}); return err }},
				{"enter-markdown", func() error { _, err := es.EnterMarkdown(uuid); return err }},
				{"enter-wysiwyg", func() error { return es.EnterWysiwyg(uuid) }},
				{"flush", func() error { return es.Flush(uuid) }},
				{"create", func() error { _, _, err := es.CreateBlock(uuid, kind, nil, block.AppendIndex); return err }},
				{"paste-slice", func() error { _, err := es.HandlePasteSlice(uuid, [][]block.ContentEntry{entries}, 0); return err }},
				{"extract", func() error {
					_, _, err := es.CreateBlockFromEntries(uuid, kind, entries, block.ActionExtract, uuid)
					return err
				}},
				{"transform", func() error {
					_, _, err := es.CreateBlockFromEntries(uuid, kind, entries, block.ActionTransform, uuid)
					return err
				}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					err := tc.verb()
					if !errors.Is(err, ErrNotDocument) {
						t.Errorf("err = %v, want ErrNotDocument", err)
					}
					if err != nil && !strings.Contains(err.Error(), session.says) {
						t.Errorf("err = %v, want it to say it %s", err, session.says)
					}
				})
			}
			for name, paste := range map[string]func() block.PasteResult{
				"paste":     func() block.PasteResult { return es.HandlePaste(uuid, entries, 0) },
				"placement": func() block.PasteResult { return es.HandlePlacement(uuid, entries, 0) },
			} {
				if res := paste(); res.Outcome != block.OutcomeNothing {
					t.Errorf("%s = %+v, want nothing", name, res)
				}
			}
			if after, _ := es.FrontendBlocks(uuid); fmt.Sprint(after) != fmt.Sprint(before) {
				t.Errorf("a refused verb changed the session: %+v → %+v", before, after)
			}
		})
	}
}

func TestContainerSession_CloseFlushesAndFilesNothing(t *testing.T) {
	es, containers, c, filer := newContainerEditor(t)
	uuid := c.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	es.CloseDocument(uuid)
	es.Close(uuid)
	es.CloseDocument(uuid)
	es.CloseAllAndFile([]string{uuid})
	es.FileDocument(uuid)
	es.WaitForJobs()
	waitFiling(t, func() bool { return filer.count(uuid) > 0 })

	if got := filer.count(uuid); got != 0 {
		t.Errorf("a block container was filed %d time(s)", got)
	}
	if stored, err := containers.Load(uuid); err != nil || stored.Version() != c.Version() {
		t.Errorf("closing wrote the container: version %d → %v (%v)", c.Version(), stored, err)
	}
}

func TestContainerSession_ASaveReachesTheOpenSessionAsAnAttrsUpdate(t *testing.T) {
	es, containers, c, _ := newContainerEditor(t)
	uuid := c.UUID()
	type pushed struct {
		uuid, blockID string
		attrs         map[string]interface{}
	}
	var got []pushed
	es.SetLifecycleListener(&mockLifecycleListener{onUpdated: func(uuid, blockID string, attrs map[string]interface{}) {
		got = append(got, pushed{uuid, blockID, attrs})
	}})

	c.Merge(map[string]interface{}{"source": "before open"})
	c, err := containers.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a save with no session open pushed %+v", got)
	}

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	c.Merge(map[string]interface{}{"source": "y := 2"})
	if _, err := containers.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(got) != 1 || got[0].uuid != uuid || got[0].blockID != uuid || got[0].attrs["source"] != "y := 2" {
		t.Fatalf("pushed %+v, want one attrs update carrying the saved source", got)
	}
	if blocks, _ := es.FrontendBlocks(uuid); blocks[0].Attrs["source"] != "y := 2" {
		t.Errorf("the session still holds %v", blocks[0].Attrs["source"])
	}
}
