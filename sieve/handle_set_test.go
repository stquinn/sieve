package sieve

import (
	"strings"
	"testing"
)

func TestSplitHandles_HeadKeepsTailMints(t *testing.T) {
	head := DocBlock{ID: "pr-aaaa", Kind: KindProse, Aliases: []string{"pr-xxxx"}}
	gotHead, tail := splitHandles(head)

	// Head keeps all its handles, unchanged.
	if gotHead.ID != "pr-aaaa" || len(gotHead.Aliases) != 1 || gotHead.Aliases[0] != "pr-xxxx" {
		t.Fatalf("head handles changed: %+v", gotHead)
	}
	// Tail mints exactly one fresh handle, distinct, no aliases.
	if tail.ID == "" || tail.ID == head.ID {
		t.Fatalf("tail id not freshly minted: %q", tail.ID)
	}
	if !strings.HasPrefix(tail.ID, "pr-") {
		t.Fatalf("tail id lacks prose prefix: %q", tail.ID)
	}
	if len(tail.Aliases) != 0 {
		t.Fatalf("tail should have no aliases: %+v", tail.Aliases)
	}
}

func TestMergeHandles_UnionDeduped(t *testing.T) {
	head := DocBlock{ID: "pr-aaaa", Kind: KindProse, Aliases: []string{"pr-xxxx"}}
	tail := DocBlock{ID: "pr-bbbb", Kind: KindProse, Aliases: []string{"pr-yyyy", "pr-xxxx"}}

	merged := mergeHandles(head, tail)

	if merged.ID != "pr-aaaa" {
		t.Fatalf("head id must stay primary, got %q", merged.ID)
	}
	want := []string{"pr-xxxx", "pr-bbbb", "pr-yyyy"} // pr-xxxx deduped, head.ID excluded
	if strings.Join(merged.Aliases, ",") != strings.Join(want, ",") {
		t.Fatalf("aliases: want %v got %v", want, merged.Aliases)
	}
}

func TestMergeHandles_PreservesResolution(t *testing.T) {
	head := DocBlock{ID: "pr-aaaa", Aliases: []string{"pr-xxxx"}}
	tail := DocBlock{ID: "pr-bbbb", Aliases: []string{"pr-yyyy"}}
	merged := mergeHandles(head, tail)

	resolves := map[string]bool{}
	for _, h := range merged.answersTo() {
		resolves[h] = true
	}
	// Every handle either block answered to must still resolve — spec §7's
	// "every existing ref to the tail still resolves, zero referrer rewriting".
	for _, h := range append(head.answersTo(), tail.answersTo()...) {
		if !resolves[h] {
			t.Fatalf("merged block no longer answers to %q (resolution lost)", h)
		}
	}
}

func TestMergeHandles_DoesNotMutateInput(t *testing.T) {
	head := DocBlock{ID: "pr-aaaa", Aliases: []string{"pr-xxxx"}}
	tail := DocBlock{ID: "pr-bbbb"}
	_ = mergeHandles(head, tail)

	// Purity matters for undo: the original head's alias slice must be intact
	// so undoing the merge restores the exact prior assignment (spec §7).
	if len(head.Aliases) != 1 || head.Aliases[0] != "pr-xxxx" {
		t.Fatalf("mergeHandles mutated input head.Aliases: %+v", head.Aliases)
	}
}
