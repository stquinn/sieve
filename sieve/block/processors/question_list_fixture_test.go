package processors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/block"
)

// The question-list showcase is a REAL NOTE in store form — a document directory
// holding a .meta and its {uuid}.md — hand-authored to exercise every element
// role the model allows, including the ones no composer mints yet. Tests read it
// through the genuine load path, and it can be copied into a live library to see
// the same content rendered.
const (
	showcaseDir     = "testdata/question-list-showcase"
	showcaseUUID    = "0198c1a0-0000-7000-8000-000000000001"
	showcaseOther   = "0198c1a0-ffff-7000-8000-0000000000ff"
	showcaseProseID = "0198c1a0-0000-7000-8000-000000000010"
	showcaseAskID   = "0198c1a0-0000-7000-8000-000000000020"
	showcaseFollow  = "0198c1a0-0000-7000-8000-000000000021"
	showcaseForeign = "sieve://" + showcaseOther + "/0198c1a0-ffff-7000-8000-000000000010"
	// The PROCESSED log element: the block whose parse job ran, the asset that
	// job produced, and the ref it stamped. The asset file lives in the document
	// directory, which is where FileStore.CreateAsset puts one and where the
	// served route reads it from.
	showcaseParsedLogID    = "0198c1a0-0000-7000-8000-00000000010e"
	showcaseParsedLogAsset = showcaseParsedLogID + "-parsed.json"
	showcaseParsedLogRef   = "/ui/assets/" + showcaseUUID + "/" + showcaseParsedLogAsset
)

// showcaseParsedLogSource is the log the showcase's processed element carries,
// verbatim. Spring Boot form, so the parse yields every column the Explore table
// can show — date, level, thread, logger — and mixed severities to filter on.
const showcaseParsedLogSource = "2026-08-27T11:03:58.220Z  INFO 14882 --- [retry-worker-3] c.s.retry.BackoffPolicy                  : attempt 1 scheduled in 500ms\n" +
	"2026-08-27T11:03:59.004Z  INFO 14882 --- [retry-worker-3] c.s.retry.BackoffPolicy                  : attempt 2 scheduled in 1000ms\n" +
	"2026-08-27T11:04:02.114Z  WARN 14882 --- [retry-worker-3] c.s.retry.BackoffPolicy                  : attempt 3 scheduled in 4000ms, ceiling not yet reached\n" +
	"2026-08-27T11:04:06.881Z  WARN 14882 --- [retry-worker-7] c.s.http.ConnectionPool                  : pool exhausted, queueing\n" +
	"2026-08-27T11:04:10.377Z ERROR 14882 --- [retry-worker-3] c.s.retry.BackoffPolicy                  : giving up after 4 attempts"

// loadShowcase returns the note's markdown and the shadow the load path builds
// from it — deserialize plus the whole migrator pipeline, exactly as opening the
// note in the app does.
func loadShowcase(t *testing.T) (string, *block.ShadowDocument) {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(showcaseDir, showcaseUUID+".md"))
	if err != nil {
		t.Fatalf("read showcase note: %v", err)
	}
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	return string(src), block.NewShadow(showcaseUUID, string(src), codec, 0, nil)
}

// registerShowcaseKinds registers every kind the showcase's question lists use.
func registerShowcaseKinds(t *testing.T) {
	t.Helper()
	resetRegistry()
	svc := block.BlockServices{}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	block.RegisterProcessor(NewCodeBlockProcessor(svc))
	block.RegisterProcessor(NewLogProcessor(svc))
	block.RegisterProcessor(NewReferenceProcessor(svc))
	block.RegisterProcessor(NewDiagramProcessor(svc))
	t.Cleanup(resetRegistry)
}

// The note is already in canonical form: loading and re-serializing it returns
// the bytes on disk. Mixed-kind element lists survive the trip, and a ``` fence
// INSIDE an element's source does not close the block that carries it.
func TestShowcase_RoundTripsThroughTheStoreForm(t *testing.T) {
	registerShowcaseKinds(t)
	src, shadow := loadShowcase(t)

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
	if len(blocks) != 3 {
		t.Fatalf("the note parsed as %d blocks, want prose + two ai-blocks", len(blocks))
	}
	els := blocks[1].Elements(block.QuestionAttr)
	if len(els) != 12 {
		t.Fatalf("the showcase question holds %d elements, want the full twelve", len(els))
	}
	var kinds []string
	for _, el := range els {
		kinds = append(kinds, el.Kind)
	}
	if got := strings.Join(kinds, ","); got != "reference,reference,reference,prose,code,log,log,diagram,prose,reference,reference,reference" {
		t.Errorf("element kinds/order moved: %s", got)
	}
	// The code element's own fence came back whole.
	if src := els[4].Source(); !strings.Contains(src, "// ```go\n") || !strings.Contains(src, "backoff(2)") {
		t.Errorf("an inner fence did not survive the round trip: %q", src)
	}
}

// The fold splits the showcase's twelve elements into the three slots by role, and
// the body renders every kind through its own AI seam, in list order.
func TestShowcase_FoldsIntoThreeSlots(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk, doc, ok := shadow.SnapshotForJob(showcaseAskID)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found", showcaseAskID)
	}
	q := p.foldQuestion(blk, doc)

	if got := q.targets.names(); got != block.WholeDocumentRef+","+showcaseProseID+","+showcaseForeign {
		t.Errorf("target slot = %q", got)
	}
	// rel:attach on a self-container address is an attachment — the one thing an
	// address cannot say on its own — and an unrecognised rel falls back to the
	// address, which puts the third one here too.
	var attached []string
	for _, a := range q.attachments {
		attached = append(attached, a.Title)
	}
	if got := strings.Join(attached, ","); got != "Auth Design,This Note,Rate Limits" {
		t.Errorf("attachment slot = %q", got)
	}

	const wantBody = "Compare these accounts of the retry policy.\n\n" +
		"```go\nfunc retry() {\n    // the RFC writes it as:\n    // ```go\n    // backoff(2)\n    // ```\n    backoff(2)\n}\n```\n\n" +
		"```log\n2026-08-27 11:04:02 WARN  retry attempt 3 after 4000ms\n2026-08-27 11:04:10 ERROR giving up after 4 attempts\n```\n\n" +
		"```log\n" + showcaseParsedLogSource + "\n```\n\n" +
		"```mermaid\ngraph TD\n    A[attempt] --> B{failed?}\n    B -->|yes| A\n```\n\n" +
		"Answer in two sentences."
	if got := p.questionText(q.body, doc); got != wantBody {
		t.Errorf("body slot:\n got: %q\nwant: %q", got, wantBody)
	}
}

// The follow-up's first element is a reference to the exchange it continues, so
// the walk classifies that exchange as INTERIOR and descends into ITS targets —
// where the foreign one terminates the branch and renders in place.
func TestShowcase_ChainWalk(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk, doc, ok := shadow.SnapshotForJob(showcaseFollow)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found", showcaseFollow)
	}
	w := p.resolveChain(blk, doc)

	if strings.Join(w.thread, ",") != showcaseAskID {
		t.Errorf("thread = %v, want the parent exchange", w.thread)
	}
	if strings.Join(w.local, ",") != block.WholeDocumentRef+","+showcaseProseID {
		t.Errorf("local targets = %v", w.local)
	}
	if len(w.foreign) != 1 || w.foreign[0].StringAttr("uri") != showcaseForeign {
		t.Fatalf("the foreign target is not a terminal rendered in place: %+v", w.foreign)
	}
	// Terminal means terminal: nothing from the other container was read to
	// compose this prompt.
	if _, _, question := p.buildPrompt(&blk, doc); strings.Contains(question, showcaseOther+"/") &&
		strings.Contains(question, "Retry RFC") {
		t.Errorf("the ACTION reached into the other container:\n%s", question)
	}
}

// The prompt the full model assembles, pinned. These goldens are for NEW-FORM
// content — element roles no legacy record could express — and are deliberately
// separate from the legacy-neutrality goldens in ai_block_question_migration_test.go,
// which pin what conversion must NOT move.
func TestShowcase_AssemblesTheFullPrompt(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	const wantTarget = "NODE ID: " + showcaseProseID + "\n" +
		"<!--s:" + showcaseProseID + "-->\nThe retry loop backs off exponentially, doubling each attempt.\n<!--/s:" + showcaseProseID + "-->\n\n" +
		"The retry loop backs off exponentially, doubling each attempt.\n\n" +
		"Reference: Retry RFC §4\n\n\nAddress: \"" + showcaseForeign + "\""

	const wantAction = "NODE ID: " + showcaseFollow + "\n" +
		"QUESTION ABOUT: " + showcaseAskID + "\nNow give me the counter-argument."

	p := NewAIBlockProcessor(block.BlockServices{})
	blk, doc, ok := shadow.SnapshotForJob(showcaseFollow)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found", showcaseFollow)
	}
	target, history, action := p.buildPrompt(&blk, doc)

	if target != wantTarget {
		t.Errorf("TARGET:\n got: %q\nwant: %q", target, wantTarget)
	}
	if action != wantAction {
		t.Errorf("ACTION:\n got: %q\nwant: %q", action, wantAction)
	}
	// THREAD is the parent exchange rendered whole: its own question — every
	// element of it — its manifest, then its answer.
	for _, want := range []string{
		"NODE ID: " + showcaseAskID,
		"QUESTION ABOUT: " + block.WholeDocumentRef + "," + showcaseProseID + "," + showcaseForeign,
		"```log\n2026-08-27 11:04:02 WARN",
		"ATTACHED DOCUMENTS",
		"\"title\": \"Rate Limits\"",
		"**ANSWER:** Both accounts agree on the doubling; only the ceiling differs.",
	} {
		if !strings.Contains(history, want) {
			t.Errorf("THREAD lost %q:\n%s", want, history)
		}
	}
}

// "Embed in Document" and the markdown export are ONE function: the prose
// processor's Transform asks the source's MarkdownRepresentation for the
// ActionTransform verb, and DocView.renderBlockExport asks the same — so the
// exchange a person embeds is byte-for-byte the one a document exports.
//
// The output must be WELL-FORMED MARKDOWN whatever the question is made of, and
// the hazard is the heading: an ATX heading is ONE LINE, so an element whose
// rendering opens a fence can never go on it.
//
// THE TWO REFERENCE ROLES LEAVE BY DIFFERENT DOORS. An ATTACHMENT survives as a
// markdown link — its cached title the text, its address the destination — so
// the answer keeps its provenance wherever it is embedded. A TARGET is aboutness
// and is omitted: it names material the document already holds, so the embedded
// copy sits beside it and a pointer would be a bare coordinate.
//
// These are NEW-FORM goldens, and they cover the shapes the legacy-neutrality
// table in ai_block_question_migration_test.go cannot reach: a mixed-kind body,
// a body that does not lead with prose, and more than one attachment.
func TestShowcase_EmbedsAsWellFormedMarkdown(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	const want = "### Compare these accounts of the retry policy.\n" +
		"\n" +
		"```go\n" +
		"func retry() {\n" +
		"    // the RFC writes it as:\n" +
		"    // ```go\n" +
		"    // backoff(2)\n" +
		"    // ```\n" +
		"    backoff(2)\n" +
		"}\n" +
		"```\n" +
		"\n" +
		"```log\n" +
		"2026-08-27 11:04:02 WARN  retry attempt 3 after 4000ms\n" +
		"2026-08-27 11:04:10 ERROR giving up after 4 attempts\n" +
		"```\n" +
		"\n" +
		"```log\n" + showcaseParsedLogSource + "\n```\n" +
		"\n" +
		"```mermaid\n" +
		"graph TD\n" +
		"    A[attempt] --> B{failed?}\n" +
		"    B -->|yes| A\n" +
		"```\n" +
		"\n" +
		"Answer in two sentences.\n" +
		"\n" +
		// The three attachments, in list order — including the one whose rel the
		// grammar does not know, which the address rule put in this slot.
		"[Auth Design](sieve://0198c1a0-aaaa-7000-8000-0000000000aa)\n" +
		"\n" +
		"[This Note](sieve://" + showcaseUUID + ")\n" +
		"\n" +
		"[Rate Limits](sieve://0198c1a0-bbbb-7000-8000-0000000000bb)\n" +
		"\n" +
		"Both accounts agree on the doubling; only the ceiling differs."

	p := NewAIBlockProcessor(block.BlockServices{})
	got := p.MarkdownRepresentation(showcaseBlock(t, shadow, showcaseAskID), showcaseUUID)
	if got != want {
		t.Errorf("embed moved:\n got: %q\nwant: %q", got, want)
	}

	// Asserted apart from the golden so the REASON the first line looks the way
	// it does survives a re-capture of the bytes.
	head := strings.SplitN(got, "\n", 2)[0]
	if !strings.HasPrefix(head, "### ") || strings.Contains(head, "```") {
		t.Errorf("heading is not a single line of prose: %q", head)
	}
}

// An unanswered exchange embeds as nothing: there is no answer to embed, and a
// question left on its own would read as the document's own heading.
func TestShowcase_AnUnansweredExchangeEmbedsAsNothing(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)
	p := NewAIBlockProcessor(block.BlockServices{})
	if got := p.MarkdownRepresentation(showcaseBlock(t, shadow, showcaseFollow), showcaseUUID); got != "" {
		t.Errorf("MarkdownRepresentation = %q, want empty", got)
	}
}

// The shapes the showcase cannot carry: a question that does not lead with one
// line of prose has no title to lift onto a heading — plus the two reference
// roles at the doors they leave by.
func TestAIBlock_EmbedHeadingIsOneLineOfProseOrNothing(t *testing.T) {
	registerShowcaseKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})

	answered := func(question []interface{}) block.SieveBlock {
		return block.NewSieveBlock("ai-block", showcaseAskID, map[string]interface{}{
			"id": showcaseAskID, "type": "ASK", "status": block.BlockStatusComplete,
			block.QuestionAttr: question, block.AnswerAttr: "an answer",
		})
	}
	element := func(kind string, attrs map[string]interface{}) interface{} {
		return map[string]interface{}{"kind": kind, "attrs": attrs}
	}

	cases := []struct {
		name     string
		question []interface{}
		want     string
	}{
		{
			name: "leading code puts the fence in the body, never on the heading",
			question: []interface{}{
				element("code", map[string]interface{}{"language": "go", "source": "func f() {}"}),
				element(block.KindProse, map[string]interface{}{"content": "what does this do?"}),
			},
			want: "```go\nfunc f() {}\n```\n\nwhat does this do?\n\nan answer",
		},
		{
			name: "a multi-line question titles on its first line and keeps the rest as prose",
			question: []interface{}{
				element(block.KindProse, map[string]interface{}{"content": "compare these\n\nand mind the ceiling"}),
			},
			want: "### compare these\n\nand mind the ceiling\n\nan answer",
		},
		{
			name: "a TARGET names what the document already holds, so it embeds as nothing",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{"uri": "sieve://" + showcaseUUID, "rel": block.RelTarget}),
				element(block.KindReference, map[string]interface{}{"uri": showcaseForeign, "rel": block.RelTarget}),
				element(block.KindProse, map[string]interface{}{"content": "why?"}),
			},
			want: "### why?\n\nan answer",
		},
		{
			name: "a question of TARGETS alone is its answer, with no heading",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{"uri": "sieve://" + showcaseUUID, "rel": block.RelTarget}),
			},
			want: "an answer",
		},
		{
			name: "an ATTACHMENT survives the embed as a followable link",
			question: []interface{}{
				element(block.KindProse, map[string]interface{}{"content": "why?"}),
				element(block.KindReference, map[string]interface{}{
					"uri": showcaseForeign, "rel": block.RelAttach,
					block.FaceAttr: map[string]interface{}{"title": "Retry RFC §4"},
				}),
			},
			want: "### why?\n\n[Retry RFC §4](" + showcaseForeign + ")\n\nan answer",
		},
		{
			name: "an attachment nothing has titled is linked by its address — never blank text",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{"uri": showcaseForeign, "rel": block.RelAttach}),
			},
			want: "[" + showcaseForeign + "](" + showcaseForeign + ")\n\nan answer",
		},
		{
			name: "an attachment with no address is no coordinate, and renders nothing",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{
					"rel": block.RelAttach, block.FaceAttr: map[string]interface{}{"title": "Nowhere"},
				}),
			},
			want: "an answer",
		},
		// A title is whatever a document was called or a model wrote. Brackets in
		// one would close the link's text early and leave the address as prose.
		{
			name: "a title carrying brackets cannot close the link it labels",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{
					"uri": "sieve://" + showcaseOther, "rel": block.RelAttach,
					block.FaceAttr: map[string]interface{}{"title": `RFC [4] \ (draft]`},
				}),
			},
			want: `[RFC \[4\] \\ (draft\]](sieve://` + showcaseOther + ")\n\nan answer",
		},
		// A leaf may be an ASSET KEY — a filename, spaces and parentheses
		// included — so the destination takes the angle-bracket production.
		{
			name: "an address whose leaf is a filename is wrapped, not left to break",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{
					"uri": "sieve://" + showcaseOther + "/spec (v2).pdf", "rel": block.RelAttach,
					block.FaceAttr: map[string]interface{}{"title": "The Spec"},
				}),
			},
			want: "[The Spec](<sieve://" + showcaseOther + "/spec (v2).pdf>)\n\nan answer",
		},
		{
			name: "an address carrying an angle bracket escapes it inside the wrapper",
			question: []interface{}{
				element(block.KindReference, map[string]interface{}{
					"uri": "sieve://" + showcaseOther + "/a b<c>.txt", "rel": block.RelAttach,
				}),
			},
			want: `[sieve://` + showcaseOther + `/a b<c>.txt](<sieve://` + showcaseOther + `/a b\<c\>.txt>)` + "\n\nan answer",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := p.MarkdownRepresentation(answered(tc.question), showcaseUUID); got != tc.want {
				t.Errorf("\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// THE PARSED ASSET IS NOT HAND-WRITTEN, and this is what keeps it honest: the
// committed file must be byte-for-byte what the log kind's own parser produces
// from the element's own source. The showcase exists to be LOADED, so a fixture
// that merely looked plausible would show a reader something the app never makes.
//
// The element's attrs are held to the same standard — they are what the parse
// job's Apply stamps, and the ref is where FileStore.CreateAsset puts the file
// and where the served route reads it from.
func TestShowcase_TheParsedLogAssetIsWhatTheParserProduces(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	var el *block.SieveBlock
	for _, e := range showcaseBlock(t, shadow, showcaseAskID).Elements(block.QuestionAttr) {
		if e.ID == showcaseParsedLogID {
			el = e
		}
	}
	if el == nil {
		t.Fatalf("the showcase has no processed log element %s", showcaseParsedLogID)
	}
	if got := el.StringAttr("source"); got != showcaseParsedLogSource {
		t.Fatalf("the element's source is not the log the asset was parsed from:\n got: %q\nwant: %q", got, showcaseParsedLogSource)
	}

	parsed := parseLogLines(showcaseParsedLogSource, nil)
	want, err := json.Marshal(parsed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(showcaseDir, showcaseParsedLogAsset))
	if err != nil {
		t.Fatalf("the parsed asset is missing from the document directory: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("the committed asset is not what the parser produces:\n got: %s\nwant: %s", got, want)
	}

	for _, c := range []struct{ attr, want string }{
		{"parsedAssetRef", showcaseParsedLogRef},
		{"logFormatName", parsed.Format},
		{"logFormatRegex", parsed.Pattern},
		{"status", block.BlockStatusComplete},
	} {
		if got := el.StringAttr(c.attr); got != c.want {
			t.Errorf("%s = %q, want %q", c.attr, got, c.want)
		}
	}
}

// The two log elements are the read-only log's two arms, side by side: one whose
// parse job ran and one that was never processed. A record shows the rich table
// for the first and the raw text for the second, and the renderer decides which
// from `parsedAssetRef` alone.
func TestShowcase_CarriesBothLogArms(t *testing.T) {
	registerShowcaseKinds(t)
	_, shadow := loadShowcase(t)

	var refs []string
	for _, el := range showcaseBlock(t, shadow, showcaseAskID).Elements(block.QuestionAttr) {
		if el.Kind == "log" {
			refs = append(refs, el.StringAttr("parsedAssetRef"))
		}
	}
	if len(refs) != 2 {
		t.Fatalf("want two log elements, got %d", len(refs))
	}
	if refs[0] != "" {
		t.Errorf("the first log element should be the UNPROCESSED arm, got ref %q", refs[0])
	}
	if refs[1] != showcaseParsedLogRef {
		t.Errorf("the second log element should be the PROCESSED arm, got ref %q", refs[1])
	}
}

// showcaseBlock returns one block of the loaded showcase by id.
func showcaseBlock(t *testing.T, shadow *block.ShadowDocument, id string) block.SieveBlock {
	t.Helper()
	for _, b := range shadow.SnapshotBlocks() {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("showcase has no block %s", id)
	return block.SieveBlock{}
}
