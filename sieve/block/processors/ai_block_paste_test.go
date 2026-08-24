package processors

import (
	"sieve/sieve/block"
	"testing"
)

// aiBlockPaster is the processor as the registry builds it — with its fence tag
// set. A zero-valued one declares no region, so it claims no fence, which the
// last case here pins.
func aiBlockPaster() *AIBlockProcessor {
	return &AIBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "ai-block"}}
}

func fencedAIBlock(body string) []block.ContentEntry {
	return []block.ContentEntry{{MIMEType: "text/plain", Content: "```ai-block\n" + body + "\n```"}}
}

// Pasting an ai-block's own fenced form re-creates the block. It is the form a
// copy out of markdown mode (or out of the file on disk) produces, and it used to
// be reconstructed client-side — which made a structural mutation the one thing
// the editor did without asking Go.
func TestAIBlockPaste_fencedFormIsClaimedAndParsed(t *testing.T) {
	p := aiBlockPaster()
	entries := fencedAIBlock("id: ab-1\nstatus: COMPLETE\ntype: ASK\nquestion: why?\nresponse: because\nref: blk-9")

	if !p.IsSupportedContent(entries).Has(block.ActionPaste) {
		t.Fatal("an ai-block fence should be claimed for paste")
	}

	overrides := p.Transform(entries, "doc-1", "ab-new", block.ActionPaste)
	if overrides == nil {
		t.Fatal("expected the fence to yield attrs")
	}
	for key, want := range map[string]interface{}{
		"status": "COMPLETE", "type": "ASK", "question": "why?", "response": "because", "ref": "blk-9",
	} {
		if overrides[key] != want {
			t.Errorf("attr %q = %v, want %v", key, overrides[key], want)
		}
	}
	// The pasted id is DROPPED — the framework mints one, so a paste can never put
	// a second block with the same identity into the document.
	if _, present := overrides["id"]; present {
		t.Error("the pasted id must not survive into a new block's overrides")
	}

	// InitAttrs is where those overrides land, and a completed answer must stay
	// completed: re-running the job on paste would replace the answer being pasted.
	attrs := p.InitAttrs("ab-new", overrides)
	if attrs["id"] != "ab-new" {
		t.Errorf("expected the minted id, got %v", attrs["id"])
	}
	if attrs["status"] != "COMPLETE" || attrs["response"] != "because" {
		t.Errorf("expected the pasted answer to survive, got status=%v response=%v", attrs["status"], attrs["response"])
	}
}

// An alias is a name inside ONE document, given by a deliberate act. A copy
// inherits neither, so the aliases key must not ride the paste into a new block.
func TestAIBlockPaste_fencedFormDropsAliases(t *testing.T) {
	overrides := aiBlockPaster().Transform(
		fencedAIBlock("id: ab-1\nstatus: COMPLETE\naliases:\n  - the-answer"), "doc-1", "ab-new", block.ActionPaste)
	if overrides == nil {
		t.Fatal("expected attrs")
	}
	if _, present := overrides["aliases"]; present {
		t.Error("a pasted copy must not inherit the original's aliases")
	}
}

func TestAIBlockPaste_declinesWhatIsNotItsOwnFence(t *testing.T) {
	p := aiBlockPaster()
	for name, entries := range map[string][]block.ContentEntry{
		"another kind's fence":  {{MIMEType: "text/plain", Content: "```diagram\nsource: x\n```"}},
		"a fence inside prose":  {{MIMEType: "text/plain", Content: "see:\n```ai-block\nid: x\n```"}},
		"an unterminated fence": {{MIMEType: "text/plain", Content: "```ai-block\nid: x\n"}},
		"plain text":            {{MIMEType: "text/plain", Content: "just words"}},
	} {
		if p.IsSupportedContent(entries).Has(block.ActionPaste) {
			t.Errorf("%s: should not be claimed", name)
		}
		if p.Transform(entries, "doc-1", "ab-new", block.ActionPaste) != nil {
			t.Errorf("%s: should yield no attrs", name)
		}
	}
}

// A malformed body is a decline, not a panic: the recogniser only proves the
// delimiters, and the YAML between them is still whatever was on the clipboard.
func TestAIBlockPaste_malformedYamlDeclines(t *testing.T) {
	entries := fencedAIBlock("\tnot: [valid, yaml")
	if aiBlockPaster().Transform(entries, "doc-1", "ab-new", block.ActionPaste) != nil {
		t.Error("expected a malformed fence body to yield no attrs")
	}
}
