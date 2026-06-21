package block

import (
	"testing"
)

type mockProcessor struct {
	FencedSerializer
	FencedDeserializer
	isBlockFn   func([]ContentEntry) bool
	transformFn func([]ContentEntry) map[string]interface{}
}

func (p *mockProcessor) Kind() string { return p.FencedDeserializer.Kind }

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
func (p *mockProcessor) BuildContext(_ SieveBlock, _ DocView, _ map[string]bool) AIContext {
	return AIContext{}
}
func (p *mockProcessor) MarkdownRepresentation(_ SieveBlock) string { return "" }
func (p *mockProcessor) RunJob(_ JobContext) error                  { return nil }
func (p *mockProcessor) JobLabel(_ *SieveBlock) string              { return "" }
func (p *mockProcessor) OnChange(_ *SieveBlock)                     {}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	ResetRegistry()
	mock := &mockProcessor{FencedDeserializer: FencedDeserializer{Kind: "test-kind"}}
	RegisterProcessor(mock)
	if GetProcessor("test-kind") == nil {
		t.Fatal("expected processor to be registered, got nil")
	}
}

func TestRegisterProcessor_unknownKindReturnsNil(t *testing.T) {
	ResetRegistry()
	if GetProcessor("no-such-kind") != nil {
		t.Fatal("expected nil for unregistered kind")
	}
}

func TestPasteMatchers_firstMatchWins(t *testing.T) {
	ResetRegistry()
	specific := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "specific"},
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
		FencedDeserializer: FencedDeserializer{Kind: "general"},
		isBlockFn:          func(_ []ContentEntry) bool { return true },
		transformFn: func(_ []ContentEntry) map[string]interface{} {
			return map[string]interface{}{"winner": "general"}
		},
	}
	RegisterProcessor(specific)
	RegisterProcessor(general)

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

// A copied block round-trips as its own kind: an upgrading processor (diagram,
// which greedily claims mermaid source) is registered FIRST, yet a pasted
// sieve/code view still comes back as code — the self-kind pass wins. The same
// raw mermaid TEXT (no sieve view) still upgrades to diagram in the general pass.
func TestFirstPasteMatch_selfKindBeatsUpgrade(t *testing.T) {
	ResetRegistry()
	// diagram: registered first, claims anything mermaid (sieve/code w/ mermaid OR raw text).
	diagram := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "diagram"},
		isBlockFn: func(entries []ContentEntry) bool {
			for _, e := range entries {
				if e.MIMEType == "sieve/diagram" {
					return true
				}
				if k, attrs, ok := e.SieveAttrs(); ok && k == "code" && attrs["language"] == "mermaid" {
					return true // "upgrade" a mermaid code block to a diagram
				}
				if e.MIMEType == "text/plain" && e.Content == "graph TD; A-->B" {
					return true // raw mermaid text → diagram
				}
			}
			return false
		},
	}
	// code: claims its own sieve/code view.
	code := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "code"},
		isBlockFn: func(entries []ContentEntry) bool {
			for _, e := range entries {
				if k, _, ok := e.SieveAttrs(); ok && k == "code" {
					return true
				}
			}
			return false
		},
	}
	RegisterProcessor(diagram)
	RegisterProcessor(code)

	// Copied mermaid code block: sieve/code (lang=mermaid) + its text view.
	copied := []ContentEntry{
		{MIMEType: "sieve/code", Content: `{"id":"co-1","language":"mermaid","source":"graph TD; A-->B"}`},
		{MIMEType: "text/plain", Content: "graph TD; A-->B"},
	}
	if kind, _, ok := FirstPasteMatch(copied); !ok || kind != "code" {
		t.Fatalf("copied sieve/code (mermaid) should round-trip as code, got kind=%q ok=%v", kind, ok)
	}

	// Raw mermaid text only (no sieve view): general pass → diagram upgrade.
	raw := []ContentEntry{{MIMEType: "text/plain", Content: "graph TD; A-->B"}}
	if kind, _, ok := FirstPasteMatch(raw); !ok || kind != "diagram" {
		t.Fatalf("raw mermaid text should upgrade to diagram, got kind=%q ok=%v", kind, ok)
	}
}

func TestUnregisterProcessor_removesFromRegistryAndMatchers(t *testing.T) {
	ResetRegistry()
	mock := &mockProcessor{FencedDeserializer: FencedDeserializer{Kind: "tmp-kind"}}
	RegisterProcessor(mock)
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
