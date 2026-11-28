package block

import (
	"strings"
	"testing"
	"time"

	"sieve/sieve/domain"
)

// LiveBlocks unit tests (white-box: same package). They exercise list mechanics
// that serialize nothing, so they need no processor registry.

func TestLiveBlocks_mergeBlockCreatesEntry(t *testing.T) {
	live := &LiveBlocks{}

	live.MergeBlock(domain.SieveBlock{
		Kind:  "code",
		ID:    "cb-0001",
		Attrs: map[string]interface{}{"id": "cb-0001", "source": "fmt.Println()"},
	})

	blk := live.findBlock("cb-0001")
	if blk == nil {
		t.Fatal("expected block cb-0001 to exist")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", blk.Kind)
	}
}

func TestLiveBlocks_mergeBlockMergesAttrs(t *testing.T) {
	live := &LiveBlocks{Blocks: []domain.SieveBlock{
		{ID: "cb-0001", Kind: "code", Attrs: map[string]interface{}{
			"id": "cb-0001", "source": "old", "language": "unknown",
		}},
	}}

	live.MergeBlock(domain.SieveBlock{
		Kind:  "code",
		ID:    "cb-0001",
		Attrs: map[string]interface{}{"language": "python", "status": "COMPLETE"},
	})

	blk := live.findBlock("cb-0001")
	if blk.Attrs["source"] != "old" {
		t.Errorf("expected source to be preserved, got %v", blk.Attrs["source"])
	}
	if blk.Attrs["language"] != "python" {
		t.Errorf("expected language=python, got %v", blk.Attrs["language"])
	}
	if !strings.Contains(blk.StringAttr("status"), "COMPLETE") {
		t.Errorf("expected status merged, got %v", blk.Attrs["status"])
	}
}

// The owner hears a change through its hook from PatchBlock and MergeBlock, the
// mutations a document arms its autosave for, and from nothing else: claiming,
// writing an answer element, dropping an attr and recovering a stuck job leave
// the hook alone.
func TestLiveBlocks_hookFiresOnlyForPatchAndMerge(t *testing.T) {
	for _, tc := range []struct {
		name string
		op   func(l *LiveBlocks)
		want int
	}{
		{"MergeBlock into a held block", func(l *LiveBlocks) {
			l.MergeBlock(domain.SieveBlock{ID: "plain", Attrs: map[string]interface{}{"k": "v"}})
		}, 1},
		{"MergeBlock creating a block", func(l *LiveBlocks) {
			l.MergeBlock(domain.SieveBlock{ID: "new", Kind: "code"})
		}, 1},
		{"PatchBlock on a held block", func(l *LiveBlocks) {
			l.PatchBlock(domain.SieveBlock{ID: "plain", Attrs: map[string]interface{}{"k": "v"}})
		}, 1},
		{"PatchBlock on a block that is gone", func(l *LiveBlocks) {
			l.PatchBlock(domain.SieveBlock{ID: "gone", Attrs: map[string]interface{}{"k": "v"}})
		}, 0},
		{"TryDispatch", func(l *LiveBlocks) { l.TryDispatch("pending") }, 0},
		{"AppendElement", func(l *LiveBlocks) {
			if _, err := l.AppendElement("dispatched", AnswerAttr, domain.SieveBlock{ID: "el", Kind: KindProse}, false); err != nil {
				t.Fatalf("AppendElement: %v", err)
			}
		}, 0},
		{"DeleteBlockAttr", func(l *LiveBlocks) { l.DeleteBlockAttr("plain", "k") }, 0},
		{"ResetStuckDispatched", func(l *LiveBlocks) {
			if stuck := l.ResetStuckDispatched(time.Hour); len(stuck) != 1 {
				t.Fatalf("ResetStuckDispatched = %v, want the one dispatched block", stuck)
			}
		}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fired := 0
			live := &LiveBlocks{
				Blocks: []domain.SieveBlock{
					{ID: "plain", Kind: "code", Attrs: map[string]interface{}{"k": "v"}},
					{ID: "pending", Kind: "code", Attrs: map[string]interface{}{"status": BlockStatusPending}},
					{ID: "dispatched", Kind: "code", Attrs: map[string]interface{}{"status": BlockStatusDispatched}},
				},
				changed: func() { fired++ },
			}
			tc.op(live)
			if fired != tc.want {
				t.Errorf("hook fired %d times, want %d", fired, tc.want)
			}
		})
	}
}

func TestLiveBlocks_nilHookIsANoOp(t *testing.T) {
	live := &LiveBlocks{Blocks: []domain.SieveBlock{{ID: "b", Kind: "code", Attrs: map[string]interface{}{}}}}
	if !live.PatchBlock(domain.SieveBlock{ID: "b", Attrs: map[string]interface{}{"k": "v"}}) {
		t.Fatal("PatchBlock did not land on a held block")
	}
	live.MergeBlock(domain.SieveBlock{ID: "c", Kind: "code"})
}
