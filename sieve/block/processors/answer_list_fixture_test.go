package processors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/block"
)

// The answer-list showcase is a REAL NOTE in store form — a document directory
// holding a .meta and its {uuid}.md — hand-authored to exercise an answer
// composed of blocks no producer mints yet. Tests read it through the genuine
// load path, and it can be copied into a live library to see the same content
// rendered in the read-only record.
const (
	answerShowcaseDir     = "testdata/answer-list-showcase"
	answerShowcaseUUID    = "0198c1a0-0001-7000-8000-000000000001"
	answerShowcaseProseID = "0198c1a0-0001-7000-8000-000000000010"
	answerShowcaseAskID   = "0198c1a0-0001-7000-8000-000000000020"
	answerShowcaseCite    = "sieve://0198c1a0-ffff-7000-8000-0000000000ff/0198c1a0-ffff-7000-8000-000000000010"
)

// answerShowcaseBody is the answer slot rendered: every element through its own
// kind's AI seam, in list order, blank-line joined. It is the merge questionText
// performs on the question body, applied to the other side of the turn.
//
// The body is the merged CONTENT, so an element's TRAILERS are not in it — the
// reference element contributes its cached face and not the `Address:` tag it
// carries when rendered as a target. That is the question body's rule, and the
// two sides of a turn render alike.
const answerShowcaseBody = "The third attempt never ran — the connection pool was exhausted first, so the backoff ceiling was never reached.\n\n" +
	"```go\nfunc backoff(attempt int) time.Duration {\n" +
	"    // the RFC writes it as:\n    // ```go\n    // min(base<<attempt, ceiling)\n    // ```\n" +
	"    return min(base<<attempt, ceiling)\n}\n```\n\n" +
	"```log\n2026-08-27 11:04:06 WARN  pool exhausted, queueing\n2026-08-27 11:04:10 ERROR giving up after 4 attempts\n```\n\n" +
	"```mermaid\ngraph TD\n    A[attempt] --> B{pool free?}\n    B -->|no| C[queue]\n    C --> D[give up]\n```\n\n" +
	"Reference: Retry RFC §4\n\n\n" +
	"Raise the pool ceiling before touching the backoff policy."

// loadAnswerShowcase returns the note's markdown and the shadow the load path
// builds from it — deserialize plus the whole migrator pipeline, exactly as
// opening the note in the app does.
func loadAnswerShowcase(t *testing.T) (string, *block.ShadowDocument) {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(answerShowcaseDir, answerShowcaseUUID+".md"))
	if err != nil {
		t.Fatalf("read showcase note: %v", err)
	}
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	return string(src), block.NewShadow(answerShowcaseUUID, string(src), codec, 0, nil)
}

// The note is already in canonical form: loading and re-serializing it returns
// the bytes on disk. A mixed-kind ANSWER list survives the trip, and a ``` fence
// INSIDE an answer element's source does not close the block that carries it.
func TestAnswerShowcase_RoundTripsThroughTheStoreForm(t *testing.T) {
	registerShowcaseKinds(t)
	src, shadow := loadAnswerShowcase(t)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	out, err := codec.Serialize(shadow.SnapshotBlocks())
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	// The stored note ends in a newline, as a file does; Serialize renders the
	// document, which does not.
	if want := strings.TrimRight(src, "\n"); out != want {
		t.Fatalf("the note is not in canonical form:\n--- on disk ---\n%s\n--- serialized ---\n%s", want, out)
	}

	blocks := shadow.SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("the note parsed as %d blocks, want prose + the answered ai-block", len(blocks))
	}
	els := blocks[1].Elements(block.AnswerAttr)
	var kinds []string
	for _, el := range els {
		kinds = append(kinds, el.Kind)
	}
	if got := strings.Join(kinds, ","); got != "prose,code,log,diagram,reference,prose" {
		t.Errorf("answer element kinds/order moved: %s", got)
	}
	if src := els[1].Source(); !strings.Contains(src, "// ```go\n") || !strings.Contains(src, "min(base<<attempt") {
		t.Errorf("an inner fence did not survive the round trip: %q", src)
	}
	// The cited source keeps its address and its cached face: an answer's
	// reference is a coordinate the reader can follow, not a decoration.
	if cite := els[4]; cite.StringAttr("uri") != answerShowcaseCite || cite.FaceString("title") != "Retry RFC §4" {
		t.Errorf("the cited reference lost its address or its face: %+v", cite.Attrs)
	}
}

// The answer renders through the SAME per-kind seam the question body does, so a
// THREAD entry carrying a multi-block answer reads to a model the way each of
// its kinds reads.
func TestAnswerShowcase_RendersEveryKindIntoTheThreadEntry(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadAnswerShowcase(t)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk, doc, ok := shadow.SnapshotForJob(answerShowcaseAskID)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found", answerShowcaseAskID)
	}

	want := "NODE ID: " + answerShowcaseAskID + "\n" +
		"QUESTION ABOUT: " + answerShowcaseProseID + "\n" +
		"Why did the retry loop give up before the ceiling?\n\n" +
		"**ANSWER:** " + answerShowcaseBody
	if got := p.BuildContext(blk, doc, map[string]bool{}).String(); got != want {
		t.Errorf("THREAD entry moved:\n got: %q\nwant: %q", got, want)
	}
}

// "Embed in Document" and the markdown export are ONE function, and a
// multi-block answer goes through it whole: the question titles the exchange,
// every answer element renders under it in list order.
func TestAnswerShowcase_EmbedsTheWholeAnswer(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadAnswerShowcase(t)

	p := NewAIBlockProcessor(block.BlockServices{})
	var ask block.SieveBlock
	for _, b := range shadow.SnapshotBlocks() {
		if b.ID == answerShowcaseAskID {
			ask = b
		}
	}

	want := "### Why did the retry loop give up before the ceiling?\n\n" + answerShowcaseBody
	if got := p.MarkdownRepresentation(ask, answerShowcaseUUID); got != want {
		t.Errorf("embed moved:\n got: %q\nwant: %q", got, want)
	}
}

// Both slots are element lists, so both are children — the answer's five kinds
// included.
func TestAnswerShowcase_ChildrenSpanBothSlots(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadAnswerShowcase(t)

	p := NewAIBlockProcessor(block.BlockServices{})
	blocks := shadow.SnapshotBlocks()
	ask := blocks[1]

	var kinds []string
	for _, c := range p.Children(&ask) {
		kinds = append(kinds, c.Kind)
	}
	if got := strings.Join(kinds, ","); got != "reference,prose,prose,code,log,diagram,reference,prose" {
		t.Errorf("Children = %s, want the question's elements then the answer's", got)
	}
}
