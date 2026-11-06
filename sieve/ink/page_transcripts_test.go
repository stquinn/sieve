package ink

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// fakeTranscriber answers every page with transcript, or err. While hold is set each transcript waits for it
// to close.
type fakeTranscriber struct {
	mu      sync.Mutex
	tier    domain.Tier
	transcript domain.PageTranscript
	err     error
	hold    chan struct{}
	read    []domain.Address
}

func (f *fakeTranscriber) Tier() domain.Tier {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tier
}

func (f *fakeTranscriber) TranscribePage(_ string, page domain.Address) (domain.PageTranscript, error) {
	f.mu.Lock()
	f.read = append(f.read, page)
	hold, transcript, err := f.hold, f.transcript, f.err
	f.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return transcript, err
}

func (f *fakeTranscriber) set(change func(*fakeTranscriber)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeTranscriber) calls() []domain.Address {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]domain.Address(nil), f.read...)
}

// fakePlantuml draws every source as an SVG naming it, or fails with err.
type fakePlantuml struct {
	mu      sync.Mutex
	err     error
	sources []string
}

func (f *fakePlantuml) Render(source string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sources = append(f.sources, source)
	if f.err != nil {
		return nil, f.err
	}
	return []byte("<svg>drawn</svg>"), nil
}

// transcriptEars records every change it is told of, as "{page} {status} running={bool}" read back
// at the moment it is told.
type transcriptEars struct {
	mu       sync.Mutex
	transcripts *PageTranscripts
	heard    []string
}

func (e *transcriptEars) TranscriptChanged(container string, page link.ID) {
	st, err := e.transcripts.Transcript(container, page)
	e.mu.Lock()
	defer e.mu.Unlock()
	if err != nil {
		e.heard = append(e.heard, err.Error())
		return
	}
	e.heard = append(e.heard, fmt.Sprintf("%s %s running=%t", page, st.Status, st.Running))
}

func (e *transcriptEars) told() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.heard...)
}

// transcriptsRig is an imagesRig whose pages are transcribed by a fake transcriber, their PlantUML drawn by a
// fake drawer, on the real job engine, with the diagram kind registered and a listener told.
type transcriptsRig struct {
	*imagesRig
	transcriber   *fakeTranscriber
	plantuml *fakePlantuml
	tracker  *services.JobTracker
	transcripts *PageTranscripts
	ears     *transcriptEars
}

// theTranscript is what the fake transcriber reads off every page.
var theTranscript = domain.PageTranscript{Parts: []domain.TranscriptPart{
	{Type: domain.TranscriptPartText, Markdown: "# Kitchen\n\nTiles [?] by Friday.\n\n- grout\n- sealant"},
	{Type: domain.TranscriptPartDiagram, Language: "mermaid", Source: "flowchart TD\n  A --> B"},
	{Type: domain.TranscriptPartDiagram, Language: "plantuml", Source: "Alice -> Bob: hi"},
}}

func newTranscriptsRig(t *testing.T, records ...link.Record) *transcriptsRig {
	t.Helper()
	rig := &transcriptsRig{imagesRig: newImagesRig(t, records...), transcriber: &fakeTranscriber{tier: domain.TierSmart, transcript: theTranscript},
		plantuml: &fakePlantuml{}, tracker: services.NewJobTracker()}
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	rig.transcripts = NewPageTranscripts(rig.svc, rig.images, rig.transcriber, rig.plantuml, block.NewDocumentCodec(block.GlobalRegistry()),
		services.NewJobEngine(nil, 2, rig.tracker))
	rig.ears = &transcriptEars{transcripts: rig.transcripts}
	rig.transcripts.Subscribe(rig.ears)
	return rig
}

// transcript is what is known of the transcript of p, failing on an error.
func (rig *transcriptsRig) transcript(p link.ID) Transcript {
	rig.t.Helper()
	st, err := rig.transcripts.Transcript(rig.uuid(), p)
	if err != nil {
		rig.t.Fatalf("Transcript(%s): %v", p, err)
	}
	return st
}

// transcribeAndWait starts transcribing p and waits for the transcript to end.
func (rig *transcriptsRig) transcribeAndWait(p link.ID) Transcript {
	rig.t.Helper()
	if _, err := rig.transcripts.Transcribe(rig.uuid(), p); err != nil {
		rig.t.Fatalf("Transcribe(%s): %v", p, err)
	}
	waitFor(rig.t, func() bool { return !rig.transcript(p).Running })
	return rig.transcript(p)
}

// key is the key page p has now.
func (rig *transcriptsRig) key(p link.ID) string {
	rig.t.Helper()
	_, key, err := rig.transcripts.page(rig.uuid(), p)
	if err != nil {
		rig.t.Fatal(err)
	}
	return key
}

// transcriptAssets are the transcript assets the container owns, sorted.
func (rig *transcriptsRig) transcriptAssets() []string {
	rig.t.Helper()
	var out []string
	for _, a := range rig.container().Assets() {
		if strings.HasPrefix(a.Key(), "transcript-") {
			out = append(out, a.Key())
		}
	}
	sort.Strings(out)
	return out
}

// shape is blocks in one line each: the kind, and what it holds.
func (rig *transcriptsRig) shape(blocks []domain.SieveBlock) []string {
	var out []string
	for _, b := range blocks {
		switch b.Kind {
		case block.KindDiagram:
			out = append(out, fmt.Sprintf("diagram %s %q %s", b.StringAttr("diagramType"), b.StringAttr("source"), b.StringAttr("status")))
		default:
			out = append(out, fmt.Sprintf("%s %q", b.Kind, b.Content()))
		}
	}
	return out
}

// A page is transcribed once, on demand, in a job: what is known of it runs none → running → ready, the
// listener hears the transcript begin and end, the transcriber is shown the page's image, and the transcript
// is kept beside the log as transcript-{page}-{key}.json, its PlantUML SVG beside it. Asking to transcribe
// a page already transcribed at its key, even of a Sieve started again, transcribes nothing; another page has
// no transcript of its own.
func TestPageTranscripts_TranscribesAPageOnDemandAndKeepsIt(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	if st := rig.transcript(page(1)); st.Status != TranscriptNone || st.Running || !st.Available || st.Blocks != nil || st.Failed != "" {
		t.Fatalf("before transcript: %+v", st)
	}
	key := rig.key(page(1))
	ready := rig.transcribeAndWait(page(1))
	if ready.Status != TranscriptReady || ready.Key != key || ready.Running || ready.Failed != "" {
		t.Fatalf("after transcribing: %+v", ready)
	}
	want := []string{
		`prose "# Kitchen\n\nTiles [?] by Friday.\n\n- grout\n- sealant"`,
		`diagram mermaid "flowchart TD\n  A --> B" COMPLETE`,
		`diagram plantuml "Alice -> Bob: hi" COMPLETE`,
	}
	if got := rig.shape(ready.Blocks); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("blocks\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if calls := rig.transcriber.calls(); len(calls) != 1 || calls[0].String() != "sieve://"+rig.uuid()+"/"+imageName(page(1), key) {
		t.Errorf("the transcriber was shown %v", calls)
	}
	if heard := rig.ears.told(); len(heard) != 2 || heard[0] != page(1).String()+" none running=true" ||
		heard[1] != page(1).String()+" ready running=false" {
		t.Errorf("the listener heard %v", heard)
	}
	svg := "transcript-" + page(1).String() + "-" + key + "-" + ready.Blocks[2].ID + ".svg"
	if assets := rig.transcriptAssets(); strings.Join(assets, " ") != strings.Join(rig.sorted("transcript-"+page(1).String()+"-"+key+".json", svg), " ") {
		t.Errorf("assets %v", assets)
	}
	if ready.Blocks[2].StringAttr("svgAsset") != "sieve://"+rig.uuid()+"/"+svg || string(rig.asset(rig.container(), svg)) != "<svg>drawn</svg>" {
		t.Errorf("the PlantUML diagram's SVG is at %q", ready.Blocks[2].StringAttr("svgAsset"))
	}

	again, err := rig.transcripts.Transcribe(rig.uuid(), page(1))
	if err != nil || again.Status != TranscriptReady || again.Running || len(rig.transcriber.calls()) != 1 {
		t.Errorf("transcribe again: %+v, %v, %d transcripts", again, err, len(rig.transcriber.calls()))
	}
	restarted := NewPageTranscripts(NewInkService(nil, reopen(t, rig.st), nil, nil), rig.images, rig.transcriber, rig.plantuml,
		block.NewDocumentCodec(block.GlobalRegistry()), services.NewJobEngine(nil, 1, nil))
	if st, err := restarted.Transcribe(rig.uuid(), page(1)); err != nil || st.Status != TranscriptReady || rig.shape(st.Blocks)[2] != want[2] {
		t.Errorf("after a restart: %+v, %v", st, err)
	}
	if st := rig.transcript(page(2)); st.Status != TranscriptNone {
		t.Errorf("page 2: %+v", st)
	}
	if _, err := rig.transcripts.Transcript(rig.uuid(), page(9)); !errors.Is(err, ErrNoSuchPage) {
		t.Errorf("a page the note does not have: %v", err)
	}
}

// sorted is names in order.
func (rig *transcriptsRig) sorted(names ...string) []string {
	sort.Strings(names)
	return names
}

// A page that changes after it was transcribed has a stale transcript, the old blocks still answered; read
// again, its transcript of the earlier key and that transcript's SVG are removed while another page's
// transcript is kept.
func TestPageTranscripts_APageThatChangedIsStaleUntilTranscribedAgain(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)), strokeAdd(page(2), stroke(2)))
	old := rig.transcribeAndWait(page(1))
	other := rig.transcribeAndWait(page(2))

	rig.append(strokeAdd(page(1), stroke(3)))
	stale := rig.transcript(page(1))
	if stale.Status != TranscriptStale || stale.Key != old.Key || stale.Key == rig.key(page(1)) ||
		strings.Join(rig.shape(stale.Blocks), "\n") != strings.Join(rig.shape(old.Blocks), "\n") || stale.Blocks[0].ID != old.Blocks[0].ID {
		t.Fatalf("stale: %+v", stale)
	}

	fresh := rig.transcribeAndWait(page(1))
	if fresh.Status != TranscriptReady || fresh.Key != rig.key(page(1)) || len(rig.transcriber.calls()) != 3 {
		t.Fatalf("transcribe again: %+v, %d transcripts", fresh, len(rig.transcriber.calls()))
	}
	want := rig.sorted(
		"transcript-"+page(1).String()+"-"+fresh.Key+".json", "transcript-"+page(1).String()+"-"+fresh.Key+"-"+fresh.Blocks[2].ID+".svg",
		"transcript-"+page(2).String()+"-"+other.Key+".json", "transcript-"+page(2).String()+"-"+other.Key+"-"+other.Blocks[2].ID+".svg")
	if got := rig.transcriptAssets(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("assets\n%v\nwant\n%v", got, want)
	}
}

// A text part is the prose blocks the document codec parses its markdown into, a diagram part a
// diagram block in its language, Mermaid unless it names PlantUML; a PlantUML diagram is drawn and
// one that will not draw keeps its source, no SVG and why. A part with nothing in it is left out.
// Every id is fresh, valid and written in both places.
func TestPageTranscripts_PartsBecomeBlocks(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	key := rig.key(page(1))
	for _, tc := range []struct {
		name     string
		parts    []domain.TranscriptPart
		drawFail error
		want     []string
	}{
		{"text", []domain.TranscriptPart{{Type: "text", Markdown: "Plain words."}}, nil, []string{`prose "Plain words."`}},
		{"text with a fence stays prose", []domain.TranscriptPart{{Type: "text", Markdown: "Before\n\n```mermaid\nA-->B\n```"}}, nil,
			[]string{"prose \"Before\\n\\n```mermaid\\nA-->B\\n```\""}},
		{"mermaid", []domain.TranscriptPart{{Type: "diagram", Language: "mermaid", Source: "graph LR\n  X --> Y\n"}}, nil,
			[]string{`diagram mermaid "graph LR\n  X --> Y" COMPLETE`}},
		{"a language that is not PlantUML is Mermaid", []domain.TranscriptPart{{Type: "diagram", Language: "flow", Source: "A --> B"}}, nil,
			[]string{`diagram mermaid "A --> B" COMPLETE`}},
		{"plantuml drawn", []domain.TranscriptPart{{Type: "diagram", Language: "PlantUML", Source: "A -> B"}}, nil,
			[]string{`diagram plantuml "A -> B" COMPLETE`}},
		{"plantuml that will not draw", []domain.TranscriptPart{{Type: "diagram", Language: "plantuml", Source: "A -> B"}}, fmt.Errorf("%w: refused", services.ErrPlantumlServerUnavailable),
			[]string{`diagram plantuml "A -> B" ERROR`}},
		{"empty parts", []domain.TranscriptPart{{Type: "text", Markdown: "  "}, {Type: "diagram", Language: "mermaid"}, {Type: "text", Markdown: "Kept"}}, nil,
			[]string{`prose "Kept"`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig.plantuml.mu.Lock()
			rig.plantuml.err = tc.drawFail
			rig.plantuml.mu.Unlock()
			blocks, err := rig.transcripts.blocks(rig.uuid(), page(1), key, domain.PageTranscript{Parts: tc.parts})
			if err != nil {
				t.Fatal(err)
			}
			if got := rig.shape(blocks); strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Errorf("blocks\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tc.want, "\n"))
			}
			for _, b := range blocks {
				if !ident.Valid(b.ID) || b.StringAttr("id") != b.ID {
					t.Errorf("block %q, attrs id %q", b.ID, b.StringAttr("id"))
				}
				if b.Kind != block.KindDiagram || b.StringAttr("diagramType") != "plantuml" {
					continue
				}
				svg := b.StringAttr("svgAsset")
				if tc.drawFail != nil {
					if svg != "" || b.StringAttr("error") != "no PlantUML server could be reached to draw this diagram" {
						t.Errorf("an undrawn diagram: %v", b.Attrs)
					}
				} else if svg != "sieve://"+rig.uuid()+"/transcript-"+page(1).String()+"-"+key+"-"+b.ID+".svg" || b.StringAttr("renderedHash") == "" {
					t.Errorf("a drawn diagram: %v", b.Attrs)
				}
			}
		})
	}
}

// A transcript that fails keeps nothing, says why, and the listener hears it begin and end; read
// again, the failure is forgotten while the page is transcribed. Nothing connected that can draw is said
// in words the transcriber can act on.
func TestPageTranscripts_AFailedTranscriptKeepsNothingAndSaysWhy(t *testing.T) {
	for _, tc := range []struct {
		name    string
		noDraw  bool
		transcribeErr error
		want    string
	}{
		{"nothing can draw the page", true, nil, TranscriptNoDrawer},
		{"the transcriber fails", false, errors.New("the model timed out"), "The page could not be transcribed: the model timed out"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
			if tc.noDraw {
				rig.transcripts.images = NewPageImages(rig.svc, nil)
			}
			rig.transcriber.set(func(f *fakeTranscriber) { f.err = tc.transcribeErr })
			failed := rig.transcribeAndWait(page(1))
			if failed.Status != TranscriptNone || failed.Failed != tc.want || failed.Running {
				t.Errorf("failed: %+v", failed)
			}
			if assets := rig.transcriptAssets(); len(assets) != 0 {
				t.Errorf("kept %v", assets)
			}
			if heard := rig.ears.told(); len(heard) != 2 || !strings.HasSuffix(heard[1], "none running=false") {
				t.Errorf("the listener heard %v", heard)
			}
			hold := make(chan struct{})
			rig.transcriber.set(func(f *fakeTranscriber) { f.err, f.hold = nil, hold })
			rig.transcripts.images = rig.images
			if st, _ := rig.transcripts.Transcribe(rig.uuid(), page(1)); !st.Running || st.Failed != "" {
				t.Errorf("transcript again: %+v", st)
			}
			close(hold)
			waitFor(t, func() bool { return rig.transcript(page(1)).Status == TranscriptReady })
		})
	}
}

// One transcript of a page runs at a time: asking again while it runs starts nothing. The job is
// named for the note and the page, in the AI pool.
func TestPageTranscripts_OneTranscriptOfAPageAtATime(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	hold := make(chan struct{})
	rig.transcriber.set(func(f *fakeTranscriber) { f.hold = hold })
	for i := 0; i < 3; i++ {
		if st, err := rig.transcripts.Transcribe(rig.uuid(), page(1)); err != nil || !st.Running {
			t.Fatalf("Transcribe %d: %+v, %v", i, st, err)
		}
	}
	waitFor(t, func() bool { return len(rig.tracker.Active()) == 1 })
	job := rig.tracker.Active()[0]
	if job.JobID != "transcribe-page:"+rig.uuid()+"/"+page(1).String() || job.Label != "Transcribing Ideas, page 1" || job.DocID != rig.uuid() || job.Category != "ai" {
		t.Errorf("the job is %+v", job)
	}
	close(hold)
	waitFor(t, func() bool { return !rig.transcript(page(1)).Running })
	if calls := rig.transcriber.calls(); len(calls) != 1 {
		t.Errorf("%d transcripts", len(calls))
	}
}

// While the AI's tier is dumb nothing can transcribe a page: what is known says so and why, and asking to
// transcribe starts nothing.
func TestPageTranscripts_NothingIsTranscribedWhileTheTierIsDumb(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	rig.transcriber.set(func(f *fakeTranscriber) { f.tier = domain.TierDumb })
	st, err := rig.transcripts.Transcribe(rig.uuid(), page(1))
	if err != nil || st.Available || st.Unavailable != TranscriptUnavailable || st.Running || st.Status != TranscriptNone {
		t.Errorf("transcribe while dumb: %+v, %v", st, err)
	}
	if len(rig.transcriber.calls()) != 0 || len(rig.ears.told()) != 0 {
		t.Errorf("%d transcripts, heard %v", len(rig.transcriber.calls()), rig.ears.told())
	}
}

// A document made from a page's transcript holds its blocks, ready or stale, and is called for the
// note and the page; a page with no transcript has none.
func TestPageTranscripts_ACopyIsTheTranscriptNamedForThePage(t *testing.T) {
	rig := newTranscriptsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(2), stroke(1)))
	if _, _, err := rig.transcripts.Copy(rig.uuid(), page(2)); err == nil {
		t.Error("a page with no transcript was copied")
	}
	ready := rig.transcribeAndWait(page(2))
	rig.append(strokeAdd(page(2), stroke(2)))
	name, blocks, err := rig.transcripts.Copy(rig.uuid(), page(2))
	if err != nil || name != "Ideas — page 2" || strings.Join(rig.shape(blocks), "\n") != strings.Join(rig.shape(ready.Blocks), "\n") {
		t.Errorf("copy: %q, %v, %v", name, rig.shape(blocks), err)
	}
}
