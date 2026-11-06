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

// fakeReader answers every page with reading, or err. While hold is set each reading waits for it
// to close.
type fakeReader struct {
	mu      sync.Mutex
	tier    domain.Tier
	reading domain.PageReading
	err     error
	hold    chan struct{}
	read    []domain.Address
}

func (f *fakeReader) Tier() domain.Tier {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tier
}

func (f *fakeReader) ReadPage(_ string, page domain.Address) (domain.PageReading, error) {
	f.mu.Lock()
	f.read = append(f.read, page)
	hold, reading, err := f.hold, f.reading, f.err
	f.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return reading, err
}

func (f *fakeReader) set(change func(*fakeReader)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

func (f *fakeReader) calls() []domain.Address {
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

// readingEars records every change it is told of, as "{page} {status} running={bool}" read back
// at the moment it is told.
type readingEars struct {
	mu       sync.Mutex
	readings *PageReadings
	heard    []string
}

func (e *readingEars) ReadingChanged(container string, page link.ID) {
	st, err := e.readings.Reading(container, page)
	e.mu.Lock()
	defer e.mu.Unlock()
	if err != nil {
		e.heard = append(e.heard, err.Error())
		return
	}
	e.heard = append(e.heard, fmt.Sprintf("%s %s running=%t", page, st.Status, st.Running))
}

func (e *readingEars) told() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.heard...)
}

// readingsRig is an imagesRig whose pages are read by a fake reader, their PlantUML drawn by a
// fake drawer, on the real job engine, with the diagram kind registered and a listener told.
type readingsRig struct {
	*imagesRig
	reader   *fakeReader
	plantuml *fakePlantuml
	tracker  *services.JobTracker
	readings *PageReadings
	ears     *readingEars
}

// theReading is what the fake reader reads off every page.
var theReading = domain.PageReading{Parts: []domain.ReadingPart{
	{Type: domain.ReadingPartText, Markdown: "# Kitchen\n\nTiles [?] by Friday.\n\n- grout\n- sealant"},
	{Type: domain.ReadingPartDiagram, Language: "mermaid", Source: "flowchart TD\n  A --> B"},
	{Type: domain.ReadingPartDiagram, Language: "plantuml", Source: "Alice -> Bob: hi"},
}}

func newReadingsRig(t *testing.T, records ...link.Record) *readingsRig {
	t.Helper()
	rig := &readingsRig{imagesRig: newImagesRig(t, records...), reader: &fakeReader{tier: domain.TierSmart, reading: theReading},
		plantuml: &fakePlantuml{}, tracker: services.NewJobTracker()}
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	rig.readings = NewPageReadings(rig.svc, rig.images, rig.reader, rig.plantuml, block.NewDocumentCodec(block.GlobalRegistry()),
		services.NewJobEngine(nil, 2, rig.tracker))
	rig.ears = &readingEars{readings: rig.readings}
	rig.readings.Subscribe(rig.ears)
	return rig
}

// reading is what is known of the reading of p, failing on an error.
func (rig *readingsRig) reading(p link.ID) Reading {
	rig.t.Helper()
	st, err := rig.readings.Reading(rig.uuid(), p)
	if err != nil {
		rig.t.Fatalf("Reading(%s): %v", p, err)
	}
	return st
}

// readAndWait starts reading p and waits for the reading to end.
func (rig *readingsRig) readAndWait(p link.ID) Reading {
	rig.t.Helper()
	if _, err := rig.readings.Read(rig.uuid(), p); err != nil {
		rig.t.Fatalf("Read(%s): %v", p, err)
	}
	waitFor(rig.t, func() bool { return !rig.reading(p).Running })
	return rig.reading(p)
}

// key is the key page p has now.
func (rig *readingsRig) key(p link.ID) string {
	rig.t.Helper()
	_, key, err := rig.readings.page(rig.uuid(), p)
	if err != nil {
		rig.t.Fatal(err)
	}
	return key
}

// readingAssets are the reading assets the container owns, sorted.
func (rig *readingsRig) readingAssets() []string {
	rig.t.Helper()
	var out []string
	for _, a := range rig.container().Assets() {
		if strings.HasPrefix(a.Key(), "reading-") {
			out = append(out, a.Key())
		}
	}
	sort.Strings(out)
	return out
}

// shape is blocks in one line each: the kind, and what it holds.
func (rig *readingsRig) shape(blocks []domain.SieveBlock) []string {
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

// A page is read once, on demand, in a job: what is known of it runs none → running → ready, the
// listener hears the reading begin and end, the reader is shown the page's image, and the reading
// is kept beside the log as reading-{page}-{key}.json, its PlantUML SVG beside it. Asking to read
// a page already read at its key, even of a Sieve started again, reads nothing; another page has
// no reading of its own.
func TestPageReadings_ReadsAPageOnDemandAndKeepsIt(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	if st := rig.reading(page(1)); st.Status != ReadingNone || st.Running || !st.Available || st.Blocks != nil || st.Failed != "" {
		t.Fatalf("before reading: %+v", st)
	}
	key := rig.key(page(1))
	ready := rig.readAndWait(page(1))
	if ready.Status != ReadingReady || ready.Key != key || ready.Running || ready.Failed != "" {
		t.Fatalf("after reading: %+v", ready)
	}
	want := []string{
		`prose "# Kitchen\n\nTiles [?] by Friday.\n\n- grout\n- sealant"`,
		`diagram mermaid "flowchart TD\n  A --> B" COMPLETE`,
		`diagram plantuml "Alice -> Bob: hi" COMPLETE`,
	}
	if got := rig.shape(ready.Blocks); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("blocks\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if calls := rig.reader.calls(); len(calls) != 1 || calls[0].String() != "sieve://"+rig.uuid()+"/"+imageName(page(1), key) {
		t.Errorf("the reader was shown %v", calls)
	}
	if heard := rig.ears.told(); len(heard) != 2 || heard[0] != page(1).String()+" none running=true" ||
		heard[1] != page(1).String()+" ready running=false" {
		t.Errorf("the listener heard %v", heard)
	}
	svg := "reading-" + page(1).String() + "-" + key + "-" + ready.Blocks[2].ID + ".svg"
	if assets := rig.readingAssets(); strings.Join(assets, " ") != strings.Join(rig.sorted("reading-"+page(1).String()+"-"+key+".json", svg), " ") {
		t.Errorf("assets %v", assets)
	}
	if ready.Blocks[2].StringAttr("svgAsset") != "sieve://"+rig.uuid()+"/"+svg || string(rig.asset(rig.container(), svg)) != "<svg>drawn</svg>" {
		t.Errorf("the PlantUML diagram's SVG is at %q", ready.Blocks[2].StringAttr("svgAsset"))
	}

	again, err := rig.readings.Read(rig.uuid(), page(1))
	if err != nil || again.Status != ReadingReady || again.Running || len(rig.reader.calls()) != 1 {
		t.Errorf("read again: %+v, %v, %d readings", again, err, len(rig.reader.calls()))
	}
	restarted := NewPageReadings(NewInkService(nil, reopen(t, rig.st), nil, nil), rig.images, rig.reader, rig.plantuml,
		block.NewDocumentCodec(block.GlobalRegistry()), services.NewJobEngine(nil, 1, nil))
	if st, err := restarted.Read(rig.uuid(), page(1)); err != nil || st.Status != ReadingReady || rig.shape(st.Blocks)[2] != want[2] {
		t.Errorf("after a restart: %+v, %v", st, err)
	}
	if st := rig.reading(page(2)); st.Status != ReadingNone {
		t.Errorf("page 2: %+v", st)
	}
	if _, err := rig.readings.Reading(rig.uuid(), page(9)); !errors.Is(err, ErrNoSuchPage) {
		t.Errorf("a page the note does not have: %v", err)
	}
}

// sorted is names in order.
func (rig *readingsRig) sorted(names ...string) []string {
	sort.Strings(names)
	return names
}

// A page that changes after it was read has a stale reading, the old blocks still answered; read
// again, its reading of the earlier key and that reading's SVG are removed while another page's
// reading is kept.
func TestPageReadings_APageThatChangedIsStaleUntilReadAgain(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)), strokeAdd(page(2), stroke(2)))
	old := rig.readAndWait(page(1))
	other := rig.readAndWait(page(2))

	rig.append(strokeAdd(page(1), stroke(3)))
	stale := rig.reading(page(1))
	if stale.Status != ReadingStale || stale.Key != old.Key || stale.Key == rig.key(page(1)) ||
		strings.Join(rig.shape(stale.Blocks), "\n") != strings.Join(rig.shape(old.Blocks), "\n") || stale.Blocks[0].ID != old.Blocks[0].ID {
		t.Fatalf("stale: %+v", stale)
	}

	fresh := rig.readAndWait(page(1))
	if fresh.Status != ReadingReady || fresh.Key != rig.key(page(1)) || len(rig.reader.calls()) != 3 {
		t.Fatalf("read again: %+v, %d readings", fresh, len(rig.reader.calls()))
	}
	want := rig.sorted(
		"reading-"+page(1).String()+"-"+fresh.Key+".json", "reading-"+page(1).String()+"-"+fresh.Key+"-"+fresh.Blocks[2].ID+".svg",
		"reading-"+page(2).String()+"-"+other.Key+".json", "reading-"+page(2).String()+"-"+other.Key+"-"+other.Blocks[2].ID+".svg")
	if got := rig.readingAssets(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("assets\n%v\nwant\n%v", got, want)
	}
}

// A text part is the prose blocks the document codec parses its markdown into, a diagram part a
// diagram block in its language, Mermaid unless it names PlantUML; a PlantUML diagram is drawn and
// one that will not draw keeps its source, no SVG and why. A part with nothing in it is left out.
// Every id is fresh, valid and written in both places.
func TestPageReadings_PartsBecomeBlocks(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	key := rig.key(page(1))
	for _, tc := range []struct {
		name     string
		parts    []domain.ReadingPart
		drawFail error
		want     []string
	}{
		{"text", []domain.ReadingPart{{Type: "text", Markdown: "Plain words."}}, nil, []string{`prose "Plain words."`}},
		{"text with a fence stays prose", []domain.ReadingPart{{Type: "text", Markdown: "Before\n\n```mermaid\nA-->B\n```"}}, nil,
			[]string{"prose \"Before\\n\\n```mermaid\\nA-->B\\n```\""}},
		{"mermaid", []domain.ReadingPart{{Type: "diagram", Language: "mermaid", Source: "graph LR\n  X --> Y\n"}}, nil,
			[]string{`diagram mermaid "graph LR\n  X --> Y" COMPLETE`}},
		{"a language that is not PlantUML is Mermaid", []domain.ReadingPart{{Type: "diagram", Language: "flow", Source: "A --> B"}}, nil,
			[]string{`diagram mermaid "A --> B" COMPLETE`}},
		{"plantuml drawn", []domain.ReadingPart{{Type: "diagram", Language: "PlantUML", Source: "A -> B"}}, nil,
			[]string{`diagram plantuml "A -> B" COMPLETE`}},
		{"plantuml that will not draw", []domain.ReadingPart{{Type: "diagram", Language: "plantuml", Source: "A -> B"}}, fmt.Errorf("%w: refused", services.ErrPlantumlServerUnavailable),
			[]string{`diagram plantuml "A -> B" ERROR`}},
		{"empty parts", []domain.ReadingPart{{Type: "text", Markdown: "  "}, {Type: "diagram", Language: "mermaid"}, {Type: "text", Markdown: "Kept"}}, nil,
			[]string{`prose "Kept"`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig.plantuml.mu.Lock()
			rig.plantuml.err = tc.drawFail
			rig.plantuml.mu.Unlock()
			blocks, err := rig.readings.blocks(rig.uuid(), page(1), key, domain.PageReading{Parts: tc.parts})
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
				} else if svg != "sieve://"+rig.uuid()+"/reading-"+page(1).String()+"-"+key+"-"+b.ID+".svg" || b.StringAttr("renderedHash") == "" {
					t.Errorf("a drawn diagram: %v", b.Attrs)
				}
			}
		})
	}
}

// A reading that fails keeps nothing, says why, and the listener hears it begin and end; read
// again, the failure is forgotten while the page is read. Nothing connected that can draw is said
// in words the reader can act on.
func TestPageReadings_AFailedReadingKeepsNothingAndSaysWhy(t *testing.T) {
	for _, tc := range []struct {
		name    string
		noDraw  bool
		readErr error
		want    string
	}{
		{"nothing can draw the page", true, nil, ReadingNoDrawer},
		{"the reader fails", false, errors.New("the model timed out"), "The page could not be read: the model timed out"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
			if tc.noDraw {
				rig.readings.images = NewPageImages(rig.svc, nil)
			}
			rig.reader.set(func(f *fakeReader) { f.err = tc.readErr })
			failed := rig.readAndWait(page(1))
			if failed.Status != ReadingNone || failed.Failed != tc.want || failed.Running {
				t.Errorf("failed: %+v", failed)
			}
			if assets := rig.readingAssets(); len(assets) != 0 {
				t.Errorf("kept %v", assets)
			}
			if heard := rig.ears.told(); len(heard) != 2 || !strings.HasSuffix(heard[1], "none running=false") {
				t.Errorf("the listener heard %v", heard)
			}
			hold := make(chan struct{})
			rig.reader.set(func(f *fakeReader) { f.err, f.hold = nil, hold })
			rig.readings.images = rig.images
			if st, _ := rig.readings.Read(rig.uuid(), page(1)); !st.Running || st.Failed != "" {
				t.Errorf("reading again: %+v", st)
			}
			close(hold)
			waitFor(t, func() bool { return rig.reading(page(1)).Status == ReadingReady })
		})
	}
}

// One reading of a page runs at a time: asking again while it runs starts nothing. The job is
// named for the note and the page, in the AI pool.
func TestPageReadings_OneReadingOfAPageAtATime(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	hold := make(chan struct{})
	rig.reader.set(func(f *fakeReader) { f.hold = hold })
	for i := 0; i < 3; i++ {
		if st, err := rig.readings.Read(rig.uuid(), page(1)); err != nil || !st.Running {
			t.Fatalf("Read %d: %+v, %v", i, st, err)
		}
	}
	waitFor(t, func() bool { return len(rig.tracker.Active()) == 1 })
	job := rig.tracker.Active()[0]
	if job.JobID != "read-page:"+rig.uuid()+"/"+page(1).String() || job.Label != "Reading Ideas, page 1" || job.DocID != rig.uuid() || job.Category != "ai" {
		t.Errorf("the job is %+v", job)
	}
	close(hold)
	waitFor(t, func() bool { return !rig.reading(page(1)).Running })
	if calls := rig.reader.calls(); len(calls) != 1 {
		t.Errorf("%d readings", len(calls))
	}
}

// While the AI's tier is dumb nothing can read a page: what is known says so and why, and asking to
// read starts nothing.
func TestPageReadings_NothingIsReadWhileTheTierIsDumb(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	rig.reader.set(func(f *fakeReader) { f.tier = domain.TierDumb })
	st, err := rig.readings.Read(rig.uuid(), page(1))
	if err != nil || st.Available || st.Unavailable != ReadingUnavailable || st.Running || st.Status != ReadingNone {
		t.Errorf("read while dumb: %+v, %v", st, err)
	}
	if len(rig.reader.calls()) != 0 || len(rig.ears.told()) != 0 {
		t.Errorf("%d readings, heard %v", len(rig.reader.calls()), rig.ears.told())
	}
}

// A document made from a page's reading holds its blocks, ready or stale, and is called for the
// note and the page; a page with no reading has none.
func TestPageReadings_ACopyIsTheReadingNamedForThePage(t *testing.T) {
	rig := newReadingsRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(2), stroke(1)))
	if _, _, err := rig.readings.Copy(rig.uuid(), page(2)); err == nil {
		t.Error("a page with no reading was copied")
	}
	ready := rig.readAndWait(page(2))
	rig.append(strokeAdd(page(2), stroke(2)))
	name, blocks, err := rig.readings.Copy(rig.uuid(), page(2))
	if err != nil || name != "Ideas — page 2" || strings.Join(rig.shape(blocks), "\n") != strings.Join(rig.shape(ready.Blocks), "\n") {
		t.Errorf("copy: %q, %v, %v", name, rig.shape(blocks), err)
	}
}
