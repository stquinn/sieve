package editor

import (
	"errors"
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
	containers.SetSavedListener(es)
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

func TestContainerSession_RefusesEveryDocumentVerb(t *testing.T) {
	es, containers, c, _ := newContainerEditor(t)
	uuid := c.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "SELECT 1"}}

	for _, tc := range []struct {
		name string
		verb func() error
	}{
		{"create-block", func() error {
			return es.HandleBlockOp(uuid, block.BlockOp{Type: "create-block", Kind: containerKind})
		}},
		{"update-block", func() error {
			return es.HandleBlockOp(uuid, block.BlockOp{Type: "update-block", BlockID: uuid, Kind: containerKind, Attrs: map[string]interface{}{"source": "y"}})
		}},
		{"delete-block", func() error { return es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: uuid}) }},
		{"doc-update", func() error { return es.UpdateMarkdown(uuid, "# replaced") }},
		{"retry merge", func() error { return es.UpdateBlock(uuid, domain.SieveBlock{ID: uuid, Attrs: map[string]interface{}{"status": "PENDING"}}) }},
		{"text-replace", func() error {
			return es.ReplaceText(uuid, domain.TextEdit{BlockID: uuid, Quote: "x", Grain: domain.GrainLiteral})
		}},
		{"export", func() error { _, err := es.Export(uuid, nil, block.MarkdownGenerator{}); return err }},
		{"enter-markdown", func() error { _, err := es.EnterMarkdown(uuid); return err }},
		{"enter-wysiwyg", func() error { return es.EnterWysiwyg(uuid) }},
		{"flush", func() error { return es.Flush(uuid) }},
		{"create", func() error { _, _, err := es.CreateBlock(uuid, containerKind, nil, block.AppendIndex); return err }},
		{"paste-slice", func() error { _, err := es.HandlePasteSlice(uuid, [][]block.ContentEntry{entries}, 0); return err }},
		{"extract", func() error {
			_, _, err := es.CreateBlockFromEntries(uuid, containerKind, entries, block.ActionExtract, uuid)
			return err
		}},
		{"transform", func() error {
			_, _, err := es.CreateBlockFromEntries(uuid, containerKind, entries, block.ActionTransform, uuid)
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.verb(); !errors.Is(err, ErrNotDocument) {
				t.Errorf("err = %v, want ErrNotDocument", err)
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

	blocks, _ := es.FrontendBlocks(uuid)
	stored, err := containers.Load(uuid)
	if err != nil || len(blocks) != 1 || blocks[0].Attrs["source"] != "x := 1" || stored.Version() != c.Version() {
		t.Errorf("a refused verb changed the container: %+v, version %d → %d", blocks, c.Version(), stored.Version())
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
