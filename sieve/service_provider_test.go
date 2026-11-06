package sieve

import (
	"errors"
	"reflect"
	"sort"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// The wire's published feature vocabulary and the producers the composition
// root registers are two halves of one fact, written in two places: the client
// names a feature with a generated constant, and the engine answers a control
// frame only for a word something registered. Neither half can see the other, so
// this is what makes drift between them loud.
//
// A word published and not registered is a switch that refuses every frame it is
// given. A producer registered and not published leaves the client naming it
// with a string literal, which is exactly how a wire stops matching its registry.
func TestServiceProvider_PublishesEveryFeatureItRegisters(t *testing.T) {
	s := registrationReady(t)
	s.RegisterInspectors(services.NewSpellService(nil))

	published := append([]string(nil), protocol.NewRegistry().Features()...)
	sort.Strings(published)
	registered := s.Inspection.Features()

	if !reflect.DeepEqual(registered, published) {
		t.Errorf("features\n registered: %v\n  published: %v", registered, published)
	}
}

// registrationReady is a provider carrying exactly what RegisterInspectors
// requires: the engine to register into, and the editor whose open documents a
// document-scoped producer reads and writes.
func registrationReady(t *testing.T) *ServiceProvider {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	documents, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	s := &ServiceProvider{Store: fs, Documents: documents}
	s.Editor = editor.NewEditorService(documents, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	t.Cleanup(s.Editor.CloseAll)
	s.Inspection = editor.NewInspectionEngine(s.Editor)
	return s
}

// A Live view lasts one run, so a tab of one saved by an earlier run is gone once a provider is
// built over the store again, and every other tab stays as it was.
func TestServiceProvider_InitClosesAnEarlierRunsLiveTabs(t *testing.T) {
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := services.NewStateService(fs, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	session := state.LoadSession()
	session.Tabs = []domain.Tab{{ID: "a-note", Kind: "note"}, {ID: "an-old-live-view", Kind: ink.KindLive}, {ID: "code", Kind: "code"}}
	session.ActiveIdx = 1
	if err := state.SaveSession(session); err != nil {
		t.Fatal(err)
	}

	s := &ServiceProvider{Jobs: services.NewJobTracker()}
	s.Init(fs, dir, nil)
	t.Cleanup(s.Editor.CloseAll)
	tabs := s.State.LoadSession().Tabs
	if len(tabs) != 2 || tabs[0].ID != "a-note" || tabs[1].ID != "code" {
		t.Errorf("tabs %+v, want the Live tab gone and the rest kept", tabs)
	}
	if node, err := s.Nodes.Resolve(domain.NewContainerAddress(s.Ink.LiveView().UUID())); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Errorf("a Live view nothing is live in resolved: %+v, %v", node, err)
	}
}
