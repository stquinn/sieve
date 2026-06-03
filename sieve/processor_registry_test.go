package sieve

import (
	"context"
	"testing"
)

type mockProcessor struct {
	matchFn func([]PasteEntry) (bool, map[string]interface{})
}

func (p *mockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": "PENDING"}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}
func (p *mockProcessor) PasteMatch(entries []PasteEntry) (bool, map[string]interface{}) {
	return p.matchFn(entries)
}
func (p *mockProcessor) BuildContext(_ SieveBlock, _ ShadowDocument) string  { return "" }
func (p *mockProcessor) RunJob(_ context.Context, _ *SieveBlock, _ Services) error { return nil }
func (p *mockProcessor) OnUpdate(_ *SieveBlock, _ Services) bool             { return false }

func resetRegistry() {
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{matchFn: func(_ []PasteEntry) (bool, map[string]interface{}) { return false, nil }}
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
	specific := &mockProcessor{matchFn: func(entries []PasteEntry) (bool, map[string]interface{}) {
		for _, e := range entries {
			if e.MIMEType == "text/plain" && e.Content == "target" {
				return true, map[string]interface{}{"winner": "specific"}
			}
		}
		return false, nil
	}}
	general := &mockProcessor{matchFn: func(_ []PasteEntry) (bool, map[string]interface{}) {
		return true, map[string]interface{}{"winner": "general"}
	}}
	RegisterProcessor("specific", specific)
	RegisterProcessor("general", general)

	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch([]PasteEntry{{MIMEType: "text/plain", Content: "target"}})
		if ok {
			if overrides["winner"] != "specific" {
				t.Errorf("expected specific to win, got %v", overrides["winner"])
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
