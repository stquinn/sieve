package editor

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store"
	"sieve/store/filestore"
)

const stickyKind = "test-sticky"

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

// newTestContainers builds the container service over a temporary store with the
// test kind registered.
func newTestContainers(t *testing.T) (*BlockContainerService, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	ds, st := newTestDocumentService(t)
	block.RegisterProcessor(stickyProc{FencedDeserializer: block.FencedDeserializer{Kind: stickyKind}})
	t.Cleanup(func() { block.UnregisterProcessor(stickyKind) })
	containers, err := NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	return containers, ds, st
}

func TestBlockContainer_CreateSaveReloadKeepsVersionsAndAssets(t *testing.T) {
	resetRegistry()
	containers, _, st := newTestContainers(t)

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
	resetRegistry()
	containers, _, _ := newTestContainers(t)
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
	resetRegistry()
	containers, ds, st := newTestContainers(t)

	if _, err := containers.Create("no-such-kind", nil); err == nil {
		t.Error("Create of an unregistered kind succeeded")
	}

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, uuid := range []string{doc.UUID(), testMissingUUID} {
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

// A container moved out of Blocks stays a container, and stays refused as a document.
func TestBlockContainer_MovedToTheLibraryIsStillABlock(t *testing.T) {
	resetRegistry()
	containers, ds, st := newTestContainers(t)
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
	if _, err := ds.LoadByUUID(c.UUID()); !errors.Is(err, domain.ErrNotADocument) {
		t.Errorf("LoadByUUID = %v, want ErrNotADocument", err)
	}
}

func TestBlockSource_Resolve(t *testing.T) {
	resetRegistry()
	containers, ds, _ := newTestContainers(t)
	source := NewBlockSource(containers)

	c, err := containers.Create(stickyKind, map[string]interface{}{"title": "old", "summary": "the summary"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	uuid := c.UUID()
	held := c.Block()
	held.Aliases = []string{"sticky-name"}
	c.block = held
	if _, err := containers.SaveAsset(c, "strokes.jsonl", []byte("12345")); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}
	c, err = containers.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	pinned := c.Versions()[0].ID
	c.Merge(map[string]interface{}{"title": "new"})
	if _, err := containers.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	for _, tc := range []struct {
		name, uri, wantID, wantKind, wantTitle, wantBody string
		wantAttrs                                        bool
	}{
		{"container", "sieve://" + uuid, uuid, stickyKind, "new", "> new", true},
		{"pinned container", "sieve://" + uuid + "?version=" + pinned, uuid, stickyKind, "old", "> old", true},
		{"block leaf", "sieve://" + uuid + "/" + uuid, uuid, stickyKind, "new", "> new", true},
		{"alias leaf", "sieve://" + uuid + "/sticky-name", uuid, stickyKind, "new", "> new", true},
		{"asset leaf", "sieve://" + uuid + "/strokes.jsonl", "strokes.jsonl", assetKind, "strokes.jsonl", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node, err := source.Resolve(mustAddress(t, tc.uri))
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if node.ID != tc.wantID || node.Kind != tc.wantKind || node.Title != tc.wantTitle || node.Body != tc.wantBody {
				t.Errorf("node = %+v", node)
			}
			if tc.wantAttrs != (node.Attrs != nil) {
				t.Errorf("Attrs = %v, want present=%v", node.Attrs, tc.wantAttrs)
			}
			if tc.wantAttrs && (node.Attrs["color"] != "yellow" || node.Summary != "the summary") {
				t.Errorf("descriptor lost the map: %+v", node)
			}
		})
	}

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for name, uri := range map[string]string{
		"a document":        "sieve://" + doc.UUID(),
		"nothing":           "sieve://" + testMissingUUID,
		"unwritten version": "sieve://" + uuid + "?version=" + strconv.Itoa(99),
		"unknown leaf":      "sieve://" + uuid + "/no-such-leaf",
	} {
		if _, err := source.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
			t.Errorf("%s: err = %v, want ErrNodeNotFound", name, err)
		}
	}
}
