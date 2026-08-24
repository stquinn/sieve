package block

import (
	"testing"

	"sieve/ident"
)

type mockProcessor struct {
	FencedSerializer
	FencedDeserializer
	actionsFn   func([]ContentEntry) SupportedActions
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
func (p *mockProcessor) IsSupportedContent(entries []ContentEntry) SupportedActions {
	if p.actionsFn != nil {
		return p.actionsFn(entries)
	}
	return SupportedActions{}
}
func (p *mockProcessor) Transform(entries []ContentEntry, _ string, _ string, action Action) map[string]interface{} {
	if p.transformFn != nil {
		return p.transformFn(entries)
	}
	return nil
}
func (p *mockProcessor) BuildContext(_ SieveBlock, _ DocView, _ map[string]bool) AIContext {
	return AIContext{}
}
func (p *mockProcessor) MarkdownRepresentation(_ SieveBlock, _ string) string { return "" }
func (p *mockProcessor) DescribeJob(_ JobContext) *ProcessorJob               { return nil }
func (p *mockProcessor) OnChange(_ *SieveBlock)                               {}

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
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if e.MIMEType == "text/plain" && e.Content == "target" {
					return SupportedActions{Kind: "specific", Actions: []Action{ActionPaste}}
				}
			}
			return SupportedActions{Kind: "specific"}
		},
		transformFn: func(entries []ContentEntry) map[string]interface{} {
			return map[string]interface{}{"winner": "specific"}
		},
	}
	general := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "general"},
		actionsFn: func(_ []ContentEntry) SupportedActions {
			return SupportedActions{Kind: "general", Actions: []Action{ActionPaste}}
		},
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
		if pm.Processor.IsSupportedContent([]ContentEntry{{MIMEType: "text/plain", Content: "target"}}).Has(ActionPaste) {
			overrides := pm.Processor.Transform([]ContentEntry{{MIMEType: "text/plain", Content: "target"}}, "", "", ActionPaste)
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
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if e.MIMEType == "sieve/diagram" {
					return SupportedActions{Kind: "diagram", Actions: []Action{ActionPaste}}
				}
				if k, attrs, ok := e.SieveAttrs(); ok && k == "code" && attrs["language"] == "mermaid" {
					return SupportedActions{Kind: "diagram", Actions: []Action{ActionPaste}} // "upgrade" a mermaid code block to a diagram
				}
				if e.MIMEType == "text/plain" && e.Content == "graph TD; A-->B" {
					return SupportedActions{Kind: "diagram", Actions: []Action{ActionPaste}} // raw mermaid text → diagram
				}
			}
			return SupportedActions{Kind: "diagram"}
		},
	}
	// code: claims its own sieve/code view.
	code := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "code"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if k, _, ok := e.SieveAttrs(); ok && k == "code" {
					return SupportedActions{Kind: "code", Actions: []Action{ActionPaste}}
				}
			}
			return SupportedActions{Kind: "code"}
		},
	}
	RegisterProcessor(diagram)
	RegisterProcessor(code)

	// Copied mermaid code block: sieve/code (lang=mermaid) + its text view.
	copied := []ContentEntry{
		{MIMEType: "sieve/code", Content: `{"id":"co-1","language":"mermaid","source":"graph TD; A-->B"}`},
		{MIMEType: "text/plain", Content: "graph TD; A-->B"},
	}
	if kind, _, _, ok := FirstPasteMatch(copied); !ok || kind != "code" {
		t.Fatalf("copied sieve/code (mermaid) should round-trip as code, got kind=%q ok=%v", kind, ok)
	}

	// Raw mermaid text only (no sieve view): general pass → diagram upgrade.
	raw := []ContentEntry{{MIMEType: "text/plain", Content: "graph TD; A-->B"}}
	if kind, _, _, ok := FirstPasteMatch(raw); !ok || kind != "diagram" {
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

func TestDetectExtractions_returnsActionsPerKind(t *testing.T) {
	ResetRegistry()
	// Register a mock that offers extract for a specific sieve/diagram entry.
	extractable := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "diagram"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if e.MIMEType == "sieve/diagram" {
					return SupportedActions{Kind: "diagram", Actions: []Action{ActionExtract}}
				}
			}
			return SupportedActions{Kind: "diagram"}
		},
	}
	RegisterProcessor(extractable)
	defer UnregisterProcessor("diagram")

	entries := []ContentEntry{{MIMEType: "sieve/diagram", Content: `{"diagramType":"mermaid","source":"graph TD;A-->B"}`}}
	offers := DetectExtractions("prose", entries)
	if len(offers) == 0 {
		t.Fatal("expected at least one offer, got none")
	}
	for _, o := range offers {
		if len(o.Actions) == 0 {
			t.Fatalf("offer for kind %q has no actions", o.Kind)
		}
	}
}

// A source nested inside a composite (its entries carry Context["parentId"]) must
// never be offered an in-place TRANSFORM: TRANSFORM replaces the source block by id,
// and the only id available is the parent composite's — replacing it would clobber
// the whole composite (e.g. an AI block's response). Defect #1, data loss. The fix:
// DetectExtractions maps any Transform -> Extract for nested sources (additive-only;
// the extracted copy lands after the parent, which survives).
func TestDetectExtractions_nestedSourceNeverOffersTransform(t *testing.T) {
	ResetRegistry()
	mock := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "diagram"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			return SupportedActions{Kind: "diagram", Actions: []Action{ActionExtract, ActionTransform}}
		},
	}
	RegisterProcessor(mock)
	defer UnregisterProcessor("diagram")

	entries := []ContentEntry{{
		MIMEType: "text/plain",
		Content:  "graph TD;A-->B",
		Context:  map[string]interface{}{"parentId": "ai-b42a"},
	}}
	offers := DetectExtractions("prose", entries)
	if len(offers) == 0 {
		t.Fatal("expected at least one offer, got none")
	}
	for _, o := range offers {
		if o.Has(ActionTransform) {
			t.Errorf("nested source (parentId set) must not be offered TRANSFORM; got %v for kind %q", o.Actions, o.Kind)
		}
		if !o.Has(ActionExtract) {
			t.Errorf("nested source must still be offered EXTRACT (additive); got %v for kind %q", o.Actions, o.Kind)
		}
	}
}

// Ids are opaque UUIDs and carry no kind — the kind-prefix scheme minted 2 random
// bytes per prefix (65,536 values, no collision check) and is gone (#75). What
// still matters is that NewSieveBlock mints on BOTH sides of the id invariant.
func TestNewSieveBlock_MintsUUID(t *testing.T) {
	b := NewSieveBlock(KindProse, "", map[string]interface{}{"content": "hi"})
	if !ident.Valid(b.ID) {
		t.Fatalf("minted id %q is not a uuid", b.ID)
	}
	if b.Attrs["id"] != b.ID {
		t.Fatalf("two-sided invariant broken: ID=%q Attrs[id]=%v", b.ID, b.Attrs["id"])
	}
	if other := NewSieveBlock(KindProse, "", nil); other.ID == b.ID {
		t.Fatalf("expected unique ids, got %q twice", b.ID)
	}
}

func TestNewSieveBlock_KeepsGivenID(t *testing.T) {
	b := NewSieveBlock(KindProse, "pr-3f2a", nil)
	if b.ID != "pr-3f2a" || b.Attrs["id"] != "pr-3f2a" {
		t.Fatalf("given id not preserved on both sides: ID=%q Attrs[id]=%v", b.ID, b.Attrs["id"])
	}
}

// A block's own FENCED form is the same self-declaration its sieve/<kind> view
// is, so it must take the round-trip pass too. Without this a general text
// matcher — registered earlier and clever about raw content — claims the bytes on
// the way past and the block comes back as something else entirely.
func TestFirstPasteMatch_fencedFormIsSelfKind(t *testing.T) {
	ResetRegistry()
	// A greedy earlier claimant: anything with a newline in it reads as code.
	code := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "code"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if e.MIMEType == "text/plain" && e.Content != "" {
					return SupportedActions{Kind: "code", Actions: []Action{ActionPaste}}
				}
			}
			return SupportedActions{Kind: "code"}
		},
	}
	// ai-block claims only its own fence.
	aiBlock := &mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "ai-block"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if (FencedDeserializer{Kind: "ai-block"}).Shape().Wraps(e.Content) {
					return SupportedActions{Kind: "ai-block", Actions: []Action{ActionPaste}}
				}
			}
			return SupportedActions{Kind: "ai-block"}
		},
	}
	RegisterProcessor(code)
	RegisterProcessor(aiBlock)

	fence := []ContentEntry{{MIMEType: "text/plain", Content: "```ai-block\nid: ab-1\nstatus: COMPLETE\n```"}}
	kind, _, fromDetection, ok := FirstPasteMatch(fence)
	if !ok || kind != "ai-block" {
		t.Fatalf("a pasted ai-block fence should come back as ai-block, got kind=%q ok=%v", kind, ok)
	}
	if fromDetection {
		t.Error("a round-trip is not detection — it must not be stamped smartPaste")
	}

	// The promotion is narrow: text that is NOT a registered kind's fence still
	// goes to whoever claims it in the general pass.
	plain := []ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	if kind, _, _, ok := FirstPasteMatch(plain); !ok || kind != "code" {
		t.Fatalf("a ```go fence is not a kind's own form, got kind=%q ok=%v", kind, ok)
	}
}

func TestRegionShape_Wraps(t *testing.T) {
	shape := FencedDeserializer{Kind: "ai-block"}.Shape()
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"the whole entry is the fence", "```ai-block\nid: x\n```", true},
		{"surrounding whitespace is not content", "\n  ```ai-block\nid: x\n```\n ", true},
		{"a longer kind is a different kind", "```ai-blockish\nid: x\n```", false},
		{"prose around it means the entry is a document, not a block", "hello\n```ai-block\nid: x\n```", false},
		{"an unterminated fence is not a region", "```ai-block\nid: x\n", false},
		{"a bare head is not a region", "```ai-block", false},
		{"another kind's fence", "```diagram\nsource: x\n```", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shape.Wraps(tc.content); got != tc.want {
				t.Errorf("Wraps(%q) = %v, want %v", tc.content, got, tc.want)
			}
		})
	}
	if (RegionShape{}).Wraps("```\nx\n```") {
		t.Error("a processor that declares no region must claim nothing")
	}
}
