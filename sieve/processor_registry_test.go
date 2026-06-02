package sieve

import (
	"context"
	"testing"
)

type mockProcessor struct {
	matchFn func(string) (bool, map[string]interface{})
}

func (p *mockProcessor) PasteMatch(c string) (bool, map[string]interface{}) { return p.matchFn(c) }
func (p *mockProcessor) BuildContext(_ SieveBlock, _ ShadowDocument) string  { return "" }
func (p *mockProcessor) RunJob(_ context.Context, _ *SieveBlock, _ Services) error { return nil }

func resetRegistry() {
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{matchFn: func(_ string) (bool, map[string]interface{}) { return false, nil }}
	RegisterProcessor("test-kind", mock)
	if GetProcessor("test-kind") == nil {
		t.Fatal("expected processor to be registered, got nil")
	}
}

func TestRegisterProcessor_unknownKindReturnsNil(t *testing.T) {
	resetRegistry()
	if GetProcessor("no-such-kind") != nil {
		t.Fatal("expected nil for unregistered kind")
	}
}

func TestPasteMatchers_firstMatchWins(t *testing.T) {
	resetRegistry()
	specific := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		if c == "target" { return true, map[string]interface{}{"winner": "specific"} }
		return false, nil
	}}
	general := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		return true, map[string]interface{}{"winner": "general"}
	}}
	RegisterProcessor("specific", specific)
	RegisterProcessor("general", general)

	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, attrs := pm.Processor.PasteMatch("target")
		if ok {
			if attrs["winner"] != "specific" {
				t.Errorf("expected specific to win, got %v", attrs["winner"])
			}
			break
		}
	}
}

func TestGenerateBlockID_formatAndUniqueness(t *testing.T) {
	id1 := GenerateBlockID("code")
	id2 := GenerateBlockID("code")
	if len(id1) < 5 {
		t.Errorf("expected ID length >= 5, got %q", id1)
	}
	if id1 == id2 {
		t.Errorf("expected unique IDs, got %q twice", id1)
	}
	if id1[:2] != "co" {
		t.Errorf("expected prefix 'co', got %q", id1[:2])
	}
}
