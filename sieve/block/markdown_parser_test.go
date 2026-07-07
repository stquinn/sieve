package block

import (
	"strings"
	"testing"
)

func TestFindBlockByIDSieveBlock(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}})
	defer UnregisterProcessor("code")
	md := "```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n"
	block, found := NewDocumentCodec(GlobalRegistry()).findBlockByID(md, "co-abcd")
	if !found {
		t.Fatal("expected to find co-abcd")
	}
	if block.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", block.Kind)
	}
}

func TestFindBlockByIDNotFound(t *testing.T) {
	_, found := NewDocumentCodec(GlobalRegistry()).findBlockByID("Just some plain markdown.\n", "co-9999")
	if found {
		t.Error("expected not found")
	}
}

func TestBuildContextForIDDispatchesByKind(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}, returnVal: "CODE CONTEXT"})
	defer UnregisterProcessor("code")
	md := "```code\nid: co-abc\nsource: x\n```\n"
	result := BuildContextForID("co-abc", DocView{Mode: "markdown", mdModeBuffer: md}, map[string]bool{}, nil)
	if !strings.Contains(result.String(), "CODE CONTEXT") {
		t.Errorf("expected dispatched processor context, got %q", result)
	}
}

func TestBuildContextForIDPreventsCycles(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}, returnVal: "CODE CONTEXT"})
	defer UnregisterProcessor("code")
	// seen map already contains the ID — must return "" without recursing.
	md := "```code\nid: co-abc\nsource: x\n```\n"
	seen := map[string]bool{"co-abc": true}
	result := BuildContextForID("co-abc", DocView{Mode: "markdown", mdModeBuffer: md}, seen, nil)
	if !result.IsEmpty() {
		t.Errorf("expected empty for already-seen ID, got %q", result)
	}
}
