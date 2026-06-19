package sieve

import (
	"testing"
)

type mockProcessor struct {
	FencedSerializer
	FencedDeserializer
	isBlockFn   func([]ContentEntry) bool
	transformFn func([]ContentEntry) map[string]interface{}
}

func (p *mockProcessor) Mode() BlockMode {
	return BlockModeBlock
}

func (p *mockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": BlockStatusPending}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}
func (p *mockProcessor) IsBlock(entries []ContentEntry) bool {
	if p.isBlockFn != nil {
		return p.isBlockFn(entries)
	}
	return false
}
func (p *mockProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
	if p.transformFn != nil {
		return p.transformFn(entries)
	}
	return nil
}
func (p *mockProcessor) BuildContext(_ SieveBlock, _ DocView, _ map[string]bool) string  { return "" }
func (p *mockProcessor) MarkdownRepresentation(_ SieveBlock) string { return "" }
func (p *mockProcessor) RunJob(_ JobContext) error { return nil }
func (p *mockProcessor) JobLabel(_ *SieveBlock) string { return "" }
func (p *mockProcessor) OnChange(_ *SieveBlock) {}

func resetRegistry() {
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
	// Prose is a BUILT-IN flavour (registered in init()), not an app-wired one — it
	// must survive a registry reset, exactly as it always exists in a real system.
	RegisterProcessor(KindProse, &ProseProcessor{})
}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{}
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
	specific := &mockProcessor{
		isBlockFn: func(entries []ContentEntry) bool {
			for _, e := range entries {
				if e.MIMEType == "text/plain" && e.Content == "target" {
					return true
				}
			}
			return false
		},
		transformFn: func(entries []ContentEntry) map[string]interface{} {
			return map[string]interface{}{"winner": "specific"}
		},
	}
	general := &mockProcessor{
		isBlockFn: func(_ []ContentEntry) bool { return true },
		transformFn: func(_ []ContentEntry) map[string]interface{} {
			return map[string]interface{}{"winner": "general"}
		},
	}
	RegisterProcessor("specific", specific)
	RegisterProcessor("general", general)

	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		if pm.Processor.IsBlock([]ContentEntry{{MIMEType: "text/plain", Content: "target"}}) {
			overrides := pm.Processor.Transform([]ContentEntry{{MIMEType: "text/plain", Content: "target"}}, "", "")
			if overrides["winner"] != "specific" {
				t.Errorf("expected specific to win, got %v", overrides["winner"])
			}
			break
		}
	}
}

func TestUnregisterProcessor_removesFromRegistryAndMatchers(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{}
	RegisterProcessor("tmp-kind", mock)
	UnregisterProcessor("tmp-kind")
	if GetProcessor("tmp-kind") != nil {
		t.Error("expected nil after UnregisterProcessor, still registered")
	}
	registryMu.RLock()
	for _, pm := range pasteMatchers {
		if pm.Kind == "tmp-kind" {
			registryMu.RUnlock()
			t.Error("expected tmp-kind removed from pasteMatchers")
			return
		}
	}
	registryMu.RUnlock()
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
