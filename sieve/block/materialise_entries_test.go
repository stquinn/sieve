package block

import "testing"

// holdingProcessor is a kind whose block refers to content it does not carry — the
// shape MaterialiseEntries exists for.
type holdingProcessor struct {
	mockProcessor
	held string
}

func (p *holdingProcessor) MaterialiseContent(uuid string, attrs map[string]interface{}) []ContentEntry {
	if p.held == "" {
		return nil
	}
	return []ContentEntry{{MIMEType: "text/plain", Content: uuid + ":" + p.held}}
}

func TestMaterialiseEntries_appendsHeldContentStampedWithItsHolder(t *testing.T) {
	ResetRegistry()
	RegisterProcessor(&holdingProcessor{
		mockProcessor: mockProcessor{FencedDeserializer: FencedDeserializer{Kind: "holder"}},
		held:          "the file text",
	})
	defer UnregisterProcessor("holder")

	entries := []ContentEntry{{MIMEType: "sieve/holder", Content: `{"id":"h-1"}`}}
	got := MaterialiseEntries("doc-9", entries)

	if len(got) != 2 {
		t.Fatalf("expected the source entry plus its held content, got %d entries", len(got))
	}
	if got[1].Content != "doc-9:the file text" {
		t.Errorf("held content: got %q", got[1].Content)
	}
	holder, ok := got[1].HolderID()
	if !ok || holder != "h-1" {
		t.Errorf("held content must be stamped with the block that holds it; got %q ok=%v", holder, ok)
	}
	if _, stamped := got[0].HolderID(); stamped {
		t.Error("the source's own view is not held content and must not be stamped")
	}
}

func TestMaterialiseEntries_leavesOrdinaryEntriesAlone(t *testing.T) {
	ResetRegistry()
	RegisterProcessor(&mockProcessor{FencedDeserializer: FencedDeserializer{Kind: "plain"}})
	defer UnregisterProcessor("plain")

	entries := []ContentEntry{
		{MIMEType: "text/plain", Content: "hello"},
		{MIMEType: "sieve/plain", Content: `{"id":"p-1"}`},
	}
	if got := MaterialiseEntries("doc-9", entries); len(got) != len(entries) {
		t.Errorf("a kind that holds nothing must add nothing; got %d entries", len(got))
	}
}

// An offer that exists ONLY because the source is holding content cannot replace
// that source: the extraction would destroy what it was read out of.
func TestDetectExtractions_offerRestingOnHeldContentIsAdditive(t *testing.T) {
	ResetRegistry()
	RegisterProcessor(&mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "reader"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if e.MIMEType == "text/plain" {
					return SupportedActions{Kind: "reader", Actions: []Action{ActionPaste, ActionTransform}}
				}
			}
			return SupportedActions{Kind: "reader"}
		},
	})
	defer UnregisterProcessor("reader")

	entries := []ContentEntry{
		{MIMEType: "sieve/holder", Content: `{"id":"h-1"}`},
		ContentEntry{MIMEType: "text/plain", Content: "the file text"}.heldBy("h-1"),
	}
	offers := DetectExtractions("holder", entries)

	reader, ok := offerFor(offers, "reader")
	if !ok {
		t.Fatalf("expected the reader kind to claim the held content; offers=%v", offers)
	}
	if reader.Has(ActionTransform) {
		t.Errorf("an offer resting on held content must not be an in-place TRANSFORM; got %v", reader.Actions)
	}
	if !reader.Has(ActionExtract) {
		t.Errorf("it must still be offered additively; got %v", reader.Actions)
	}
}

// The same kind claiming the source's OWN view keeps its in-place transform: only
// offers that rest on held content are demoted.
func TestDetectExtractions_offerRestingOnTheSourceItselfKeepsTransform(t *testing.T) {
	ResetRegistry()
	RegisterProcessor(&mockProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "sink"},
		actionsFn: func(entries []ContentEntry) SupportedActions {
			for _, e := range entries {
				if _, _, isSieve := e.SieveAttrs(); isSieve {
					return SupportedActions{Kind: "sink", Actions: []Action{ActionTransform}}
				}
			}
			return SupportedActions{Kind: "sink"}
		},
	})
	defer UnregisterProcessor("sink")

	entries := []ContentEntry{
		{MIMEType: "sieve/holder", Content: `{"id":"h-1"}`},
		ContentEntry{MIMEType: "text/plain", Content: "the file text"}.heldBy("h-1"),
	}
	offers := DetectExtractions("holder", entries)

	sink, ok := offerFor(offers, "sink")
	if !ok {
		t.Fatalf("expected the sink kind to claim the source's own view; offers=%v", offers)
	}
	if !sink.Has(ActionTransform) {
		t.Errorf("an offer that stands without the held content keeps TRANSFORM; got %v", sink.Actions)
	}
}

func offerFor(offers []SupportedActions, kind string) (SupportedActions, bool) {
	for _, o := range offers {
		if o.Kind == kind {
			return o, true
		}
	}
	return SupportedActions{}, false
}
