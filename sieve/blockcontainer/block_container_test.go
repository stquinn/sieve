package blockcontainer

import (
	"errors"
	"go/build"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/store"
	"sieve/store/filestore"
)

const (
	stickyKind  = "test-sticky"
	missingUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77"
)

// stickyProc is the small test kind: a block-mode kind through the shared fenced
// machinery, as any existing processor is, with no container-specific method.
type stickyProc struct {
	block.FencedSerializer
	block.FencedDeserializer
}

func (p stickyProc) Kind() string { return p.FencedDeserializer.Kind }
func (stickyProc) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"color": "yellow"}
	for k, v := range overrides {
		attrs[k] = v
	}
	attrs["id"] = id
	return attrs
}
func (stickyProc) IsSupportedContent([]block.ContentEntry) block.SupportedActions {
	return block.SupportedActions{}
}
func (stickyProc) Transform([]block.ContentEntry, string, string, block.Action) map[string]interface{} {
	return nil
}
func (stickyProc) DescribeJob(block.JobContext) *block.ProcessorJob { return nil }
func (stickyProc) OnChange(*block.SieveBlock)                       {}
func (stickyProc) Mode() block.BlockMode                            { return block.BlockModeBlock }
func (stickyProc) BuildContext(block.SieveBlock, block.DocView, map[string]bool) block.AIContext {
	return block.AIContext{}
}
func (stickyProc) MarkdownRepresentation(b block.SieveBlock, _ string) string {
	return "> " + b.StringAttr("title")
}

// newTestContainers builds the service over a temporary store, with the test kind
// registered on top of the prose terminal the document codec needs.
func newTestContainers(t *testing.T) (*BlockContainerService, *filestore.FileStore) {
	t.Helper()
	st, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	block.ResetRegistry()
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(stickyProc{FencedDeserializer: block.FencedDeserializer{Kind: stickyKind}})
	t.Cleanup(block.ResetRegistry)
	containers, err := NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	return containers, st
}

func TestBlockContainer_CreateSaveReloadKeepsVersionsAndAssets(t *testing.T) {
	containers, st := newTestContainers(t)

	c, err := containers.Create(stickyKind, map[string]interface{}{"title": "first"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	uuid := c.UUID()
	if !ident.Valid(uuid) || c.Block().ID != uuid || c.Block().StringAttr("id") != uuid {
		t.Fatalf("identity: uuid %q block id %q attr %q", uuid, c.Block().ID, c.Block().StringAttr("id"))
	}
	if c.Kind() != stickyKind || c.Block().Kind != stickyKind || c.Block().StringAttr("color") != "yellow" {
		t.Fatalf("created = %+v", c.Block())
	}

	if _, err := containers.SaveAsset(c, "strokes.jsonl", []byte(`{"seq":1}`)); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}
	c.Merge(map[string]interface{}{"title": "second", "id": "not-this"})
	saved, err := containers.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	saved.Merge(map[string]interface{}{"title": "third"})
	saved, err = containers.Save(saved)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	dir := filepath.Join(st.Root(), "testhost", domain.Blocks.Key, uuid)
	for _, name := range []string{uuid + ".block", ".history/" + uuid + ".1.block", ".history/" + uuid + ".2.block", "strokes.jsonl"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("expected %s on disk: %v", name, err)
		}
	}

	// A fresh store resolves everything from disk.
	fresh, err := filestore.NewFileStore(st.Root(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	reopened, err := NewBlockContainerService(fresh, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	loaded, err := reopened.Load(uuid)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Kind() != stickyKind || loaded.Block().StringAttr("title") != "third" || loaded.Block().ID != uuid {
		t.Errorf("loaded = %+v (kind %q)", loaded.Block(), loaded.Kind())
	}
	if !reflect.DeepEqual(loaded.Block().Attrs, saved.Block().Attrs) {
		t.Errorf("attrs changed across reload:\n%v\n%v", loaded.Block().Attrs, saved.Block().Attrs)
	}

	versions := loaded.Versions()
	if len(versions) != 2 {
		t.Fatalf("versions = %+v, want 2", versions)
	}
	old, err := reopened.Version(loaded, versions[1])
	if err != nil {
		t.Fatalf("Version: %v", err)
	}
	if old.StringAttr("title") != "second" || old.ID != uuid {
		t.Errorf("version 1 = %+v", old)
	}
	if _, err := reopened.Version(loaded, store.VersionRef{ID: "99"}); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("unwritten version: err = %v, want fs.ErrNotExist", err)
	}

	if assets := loaded.Assets(); len(assets) != 1 || assets[0].Key() != "strokes.jsonl" {
		t.Fatalf("assets = %v, want only strokes.jsonl", assets)
	}
	asset, err := reopened.LoadAsset(loaded, "strokes.jsonl")
	if err != nil || string(asset.Body()) != `{"seq":1}` {
		t.Fatalf("LoadAsset = %v, %v", asset, err)
	}
	if err := reopened.DeleteAsset(loaded, "strokes.jsonl"); err != nil {
		t.Fatalf("DeleteAsset: %v", err)
	}
	if _, err := reopened.LoadAsset(loaded, "strokes.jsonl"); err == nil {
		t.Error("asset still loads after DeleteAsset")
	}

	if err := reopened.Delete(loaded); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := reopened.Load(uuid); !errors.Is(err, ErrNotBlockContainer) {
		t.Errorf("Load after Delete: %v, want ErrNotBlockContainer", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("directory survives Delete: %v", err)
	}
}

// One map, two forms: what a document's fence holds and what a container's file
// holds parse back to the same block.
func TestBlockContainer_AttrsRoundTripFencedAndAsAContainer(t *testing.T) {
	containers, _ := newTestContainers(t)
	cases := map[string]map[string]interface{}{
		"plain": {"title": "plain", "count": 3, "ratio": 1.5, "on": true},
		"inner fence and multiline": {
			"title":  "tricky",
			"source": "```go\nfunc main() {}\n```\n\n--- not a document marker\n",
		},
		"nested": {
			"pages": []interface{}{
				map[string]interface{}{"n": 1, "name": "one: colon"},
				map[string]interface{}{"n": 2, "name": "two # hash"},
			},
			"header": map[string]interface{}{"aspect": "3:4", "template": nil},
		},
	}
	for name, overrides := range cases {
		t.Run(name, func(t *testing.T) {
			c, err := containers.Create(stickyKind, overrides)
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			held := c.Block()
			held.Aliases = []string{"sticky-name"}
			c.block = held
			saved, err := containers.Save(c)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}

			codec := block.NewDocumentCodec(block.GlobalRegistry())
			fence, err := block.GetProcessor(stickyKind).Serialize(held)
			if err != nil {
				t.Fatalf("Serialize: %v", err)
			}
			parsed, err := codec.Deserialize(fence + "\n")
			if err != nil {
				t.Fatalf("Deserialize: %v", err)
			}
			if len(parsed) != 1 {
				t.Fatalf("fence parsed to %d blocks: %+v", len(parsed), parsed)
			}

			got := saved.Block()
			if got.ID != parsed[0].ID || got.Kind != parsed[0].Kind {
				t.Errorf("identity: container %s/%s, fence %s/%s", got.ID, got.Kind, parsed[0].ID, parsed[0].Kind)
			}
			if !reflect.DeepEqual(got.Attrs, parsed[0].Attrs) {
				t.Errorf("attrs differ:\ncontainer %#v\nfenced    %#v", got.Attrs, parsed[0].Attrs)
			}
			if !reflect.DeepEqual(got.Aliases, parsed[0].Aliases) || len(got.Aliases) != 1 {
				t.Errorf("aliases: container %v, fenced %v", got.Aliases, parsed[0].Aliases)
			}
		})
	}
}

func TestBlockContainer_RefusesWhatItDoesNotOwn(t *testing.T) {
	containers, st := newTestContainers(t)

	if _, err := containers.Create("no-such-kind", nil); err == nil {
		t.Error("Create of an unregistered kind succeeded")
	}

	doc, err := st.CreateMetaText(domain.WorkingCopy, "a-document", []byte("prose"))
	if err != nil {
		t.Fatalf("CreateMetaText: %v", err)
	}
	for _, uuid := range []string{doc.Key(), missingUUID} {
		if _, err := containers.Load(uuid); !errors.Is(err, ErrNotBlockContainer) {
			t.Errorf("Load(%s) = %v, want ErrNotBlockContainer", uuid, err)
		}
	}

	// A body that will not parse is a broken container, not a missing one.
	broken, err := st.CreateTyped(domain.Blocks, "broken", store.TypeBlock,
		map[string]string{store.MetaKeyKind: stickyKind}, []byte("a: [unclosed\n"))
	if err != nil {
		t.Fatalf("CreateTyped: %v", err)
	}
	if _, err := containers.Load(broken.Key()); err == nil || errors.Is(err, ErrNotBlockContainer) {
		t.Errorf("broken body: err = %v, want a parse failure", err)
	}
	kindless, err := st.CreateTyped(domain.Blocks, "kindless", store.TypeBlock, nil, []byte("a: b\n"))
	if err != nil {
		t.Fatalf("CreateTyped: %v", err)
	}
	if _, err := containers.Load(kindless.Key()); err == nil || errors.Is(err, ErrNotBlockContainer) {
		t.Errorf("no kind: err = %v, want a failure naming it", err)
	}
}

// A container moved out of Blocks stays a container.
func TestBlockContainer_MovedToTheLibraryIsStillABlock(t *testing.T) {
	containers, st := newTestContainers(t)
	c, err := containers.Create(stickyKind, map[string]interface{}{"title": "moved"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := st.Move(c.storable, domain.LibraryCategory); err != nil {
		t.Fatalf("Move: %v", err)
	}

	loaded, err := containers.Load(c.UUID())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Block().StringAttr("title") != "moved" {
		t.Errorf("loaded = %+v", loaded.Block())
	}
}

// The package stays below the editor and beside the document layer: sieve/ink
// creates containers while EditorService calls sieve/ink.
func TestBlockContainer_ImportsNothingAboveBlock(t *testing.T) {
	forbidden := map[string]bool{
		"sieve/sieve/editor":   true,
		"sieve/sieve/services": true,
		"sieve/sieve/ai":       true,
	}
	pkg, err := build.ImportDir(".", 0)
	if err != nil {
		t.Fatalf("ImportDir: %v", err)
	}
	for _, path := range pkg.Imports {
		if forbidden[path] {
			t.Errorf("imports %s", path)
		}
	}
}
