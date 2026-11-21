package ink

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"

	"sieve/sieve/ink/link"
)

// The companion's ids in these tests: payload, never Sieve ids.
var (
	noteID   = testID(0xa0)
	ruled    = &link.Template{ID: "ruled", Params: []link.TemplateParam{{Name: "spacing", Value: 0.05}, {Name: "margin", Value: 0.12}}}
	dots     = &link.Template{ID: "dots", Params: []link.TemplateParam{{Name: "pitch", Value: 0.025}}}
	aDevice  = link.Device{ID: "device-id", Name: "Note Air 2", Model: "ONYX NoteAir2"}
	aPoint   = link.Point{X: 0.25, Y: 0.5, Pressure: 0.75, TMillis: 0, TiltX: 30, TiltY: -30}
	offSheet = link.Point{X: -1.5, Y: -2.25, Pressure: 1, TMillis: 3, TiltX: 0, TiltY: 0}
)

func testID(n byte) link.ID {
	return link.ID{0x01, 0x9a, 0, 0, 0, 0, 0x70, 0, 0x80, 0, 0, 0, 0, 0, 0, n}
}

func page(n byte) link.ID   { return testID(0x10 + n) }
func stroke(n byte) link.ID { return testID(0x40 + n) }

// logOf numbers ops as one log from seq 1.
func logOf(ops ...link.Record) []link.Record {
	for i := range ops {
		ops[i].Seq = uint32(i + 1)
	}
	return ops
}

func header(title string) link.Record {
	return link.Record{Op: link.OpNoteHeader, Note: noteID, CreatedMillis: 1_700_000_000_000, Title: title,
		PageAspect: 0.75, Template: ruled, Device: aDevice}
}
func pageAdd(p link.ID, index uint32, t *link.Template, b link.Bounds) link.Record {
	return link.Record{Op: link.OpPageAdd, Page: p, Index: index, Template: t, Bounds: b}
}
func pageRemove(p link.ID) link.Record { return link.Record{Op: link.OpPageRemove, Page: p} }
func pageTemplate(p link.ID, t *link.Template) link.Record {
	return link.Record{Op: link.OpPageTemplate, Page: p, Template: t}
}
func strokeAdd(p, s link.ID, points ...link.Point) link.Record {
	if len(points) == 0 {
		points = []link.Point{aPoint}
	}
	return link.Record{Op: link.OpStrokeAdd, Page: p, Stroke: s, Tool: link.ToolPen, WidthClass: 2, StartMillis: 1234, Points: points}
}
func strokeRemove(p, s link.ID) link.Record {
	return link.Record{Op: link.OpStrokeRemove, Page: p, Stroke: s}
}
func noteProperty(key string, values ...string) link.Record {
	return link.Record{Op: link.OpNoteProperty, Key: key, Values: values}
}
func pageProperty(p link.ID, key string, values ...string) link.Record {
	return link.Record{Op: link.OpPageProperty, Page: p, Key: key, Values: values}
}

// strokesLog is a note of one fixed page holding n strokes.
func strokesLog(n int) []link.Record {
	ops := []link.Record{header("Strokes"), pageAdd(page(1), 0, nil, link.BoundsFixed)}
	for i := 0; i < n; i++ {
		ops = append(ops, strokeAdd(page(1), testID(byte(i)), aPoint, offSheet))
	}
	return logOf(ops...)
}

// jsonlOf is the §4.1 asset of records.
func jsonlOf(t *testing.T, records []link.Record) []byte {
	t.Helper()
	var out []byte
	for _, r := range records {
		line, err := r.JSONLine()
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, line...)
	}
	return out
}

// chainOf is the cursor a replica holding records stands at.
func chainOf(t *testing.T, records []link.Record) link.Cursor {
	t.Helper()
	var c link.Cursor
	for _, r := range records {
		body, err := r.Body()
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Accept(r, body); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

// shape describes the pages present: each page's last id byte, template and stroke id bytes.
func shape(n *StrokeBasedNote) string {
	var parts []string
	for i, p := range n.Pages() {
		tmpl := "-"
		if p.Template != nil {
			tmpl = p.Template.ID
		}
		var strokes []string
		for _, s := range n.Strokes(i) {
			strokes = append(strokes, fmt.Sprintf("%x", s.Stroke[15]-0x40))
		}
		parts = append(parts, fmt.Sprintf("p%x[%s %s]:%s", p.ID[15]-0x10, tmpl, p.Bounds, strings.Join(strokes, ",")))
	}
	return strings.Join(parts, " ")
}

func TestReplayFollowsTheContractRules(t *testing.T) {
	for _, tc := range []struct {
		name  string
		log   []link.Record
		want  string
		title string
	}{
		{"a stroke-add of a present id is a no-op",
			logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
				strokeAdd(page(1), stroke(1), offSheet), strokeAdd(page(1), stroke(2))),
			"p1[- fixed]:1,2", "n"},
		{"removing an absent stroke or page is a no-op",
			logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
				strokeRemove(page(1), stroke(9)), pageRemove(page(9)), strokeRemove(page(1), stroke(1)), strokeRemove(page(1), stroke(1))),
			"p1[- fixed]:", "n"},
		{"a removed page keeps its strokes and a page-add restores them with the record's template",
			logOf(header("n"), pageAdd(page(1), 0, ruled, link.BoundsFixed), strokeAdd(page(1), stroke(1)), strokeAdd(page(1), stroke(2)),
				pageRemove(page(1)), pageAdd(page(1), 0, dots, link.BoundsFixed)),
			"p1[dots fixed]:1,2", "n"},
		{"a removed page is not present",
			logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), pageAdd(page(2), 1, nil, link.BoundsFixed), pageRemove(page(1))),
			"p2[- fixed]:", "n"},
		{"a page-add of a present id is a no-op",
			logOf(header("n"), pageAdd(page(1), 0, ruled, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
				pageAdd(page(1), 0, dots, link.BoundsFixed)),
			"p1[ruled fixed]:1", "n"},
		{"a stroke record naming a page not present is a no-op",
			logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(9), stroke(1)),
				pageRemove(page(1)), strokeAdd(page(1), stroke(2)), pageTemplate(page(1), dots), pageAdd(page(1), 0, nil, link.BoundsFixed),
				strokeRemove(page(9), stroke(1))),
			"p1[- fixed]:", "n"},
		{"pages are placed by index, clamped, and never reordered",
			logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), pageAdd(page(2), 1, nil, link.BoundsFixed),
				pageAdd(page(3), 0, nil, link.BoundsFixed), pageRemove(page(1)), pageAdd(page(4), 99, nil, link.BoundsFixed),
				pageTemplate(page(2), dots)),
			"p3[- fixed]: p2[dots fixed]: p4[- fixed]:", "n"},
		{"a re-emitted note-header replaces the header",
			logOf(header("first"), pageAdd(page(1), 0, nil, link.BoundsFixed), header("second")),
			"p1[- fixed]:", "second"},
		{"an unbounded page holds points off the sheet",
			logOf(header("board"), pageAdd(page(1), 0, nil, link.BoundsUnbounded), strokeAdd(page(1), stroke(1), offSheet)),
			"p1[- unbounded]:1", "board"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := ReadStrokeBasedNote("container", jsonlOf(t, tc.log))
			if got := shape(n); got != tc.want {
				t.Errorf("pages %q, want %q", got, tc.want)
			}
			if n.Title() != tc.title || n.ID() != "container" || n.PageCount() != len(n.Pages()) {
				t.Errorf("title %q id %q pages %d", n.Title(), n.ID(), n.PageCount())
			}
			fold := NewHeaderFold("container")
			for _, r := range tc.log {
				fold.Apply(r)
			}
			if fold.PageCount() != n.PageCount() || fold.Title() != tc.title {
				t.Errorf("the header fold has %d pages titled %q", fold.PageCount(), fold.Title())
			}
			for i := range fold.Pages() {
				if !reflect.DeepEqual(fold.Pages()[i], n.Pages()[i]) || fold.Strokes(i) != nil {
					t.Errorf("fold page %d = %+v holding %d strokes", i, fold.Pages()[i], len(fold.Strokes(i)))
				}
			}
		})
	}
	n := ReadStrokeBasedNote("c", jsonlOf(t, logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsUnbounded),
		strokeAdd(page(1), stroke(1), offSheet), strokeAdd(page(1), stroke(1), aPoint))))
	if p := n.Strokes(0)[0].Points[0]; p != offSheet {
		t.Errorf("a repeated stroke-add replaced the first: %+v", p)
	}
}

// Each record reports what it did on top of a note of type diary and two pages, page 1 named Mon
// holding stroke 1 and page 2 named Tue, removed, holding stroke 2.
func TestApplyReportsWhatEachRecordDid(t *testing.T) {
	before := []link.Record{header("n"), noteProperty("type", "diary"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		strokeAdd(page(1), stroke(1)), pageProperty(page(1), "name", "Mon"), pageAdd(page(2), 1, nil, link.BoundsFixed),
		strokeAdd(page(2), stroke(2)), pageProperty(page(2), "name", "Tue"), pageRemove(page(2))}
	for _, tc := range []struct {
		name string
		rec  link.Record
		want Effect
		// fold is what a note keeping no strokes reports.
		fold Effect
	}{
		{"a stroke-add of a new id", strokeAdd(page(1), stroke(3)), StrokeAdded, NoEffect},
		{"a stroke-add of a present id", strokeAdd(page(1), stroke(1)), NoEffect, NoEffect},
		{"a stroke-add on a removed page", strokeAdd(page(2), stroke(3)), NoEffect, NoEffect},
		{"a stroke-add on an unknown page", strokeAdd(page(9), stroke(3)), NoEffect, NoEffect},
		{"a stroke-remove of a present id", strokeRemove(page(1), stroke(1)), StrokeRemoved, NoEffect},
		{"a stroke-remove of an absent id", strokeRemove(page(1), stroke(9)), NoEffect, NoEffect},
		{"a stroke-remove on a removed page", strokeRemove(page(2), stroke(2)), NoEffect, NoEffect},
		{"a page-add of a new page", pageAdd(page(3), 2, nil, link.BoundsFixed), NoteChanged, NoteChanged},
		{"a page-add restoring a removed page", pageAdd(page(2), 1, dots, link.BoundsFixed), NoteChanged, NoteChanged},
		{"a page-add of a present page", pageAdd(page(1), 0, dots, link.BoundsFixed), NoEffect, NoEffect},
		{"a page-remove of a present page", pageRemove(page(1)), NoteChanged, NoteChanged},
		{"a page-remove of a removed page", pageRemove(page(2)), NoEffect, NoEffect},
		{"a page-template of a present page", pageTemplate(page(1), dots), NoteChanged, NoteChanged},
		{"a page-template of a removed page", pageTemplate(page(2), dots), NoEffect, NoEffect},
		{"a note-header", header("again"), NoteChanged, NoteChanged},
		{"a note-property of a new key", noteProperty("period", "2026-11"), NoteChanged, NoteChanged},
		{"a note-property changing a key", noteProperty("type", "diary", "more"), NoteChanged, NoteChanged},
		{"a note-property of the values a key holds", noteProperty("type", "diary"), NoEffect, NoEffect},
		{"a note-property removing a key", noteProperty("type"), NoteChanged, NoteChanged},
		{"a note-property removing an absent key", noteProperty("period"), NoEffect, NoEffect},
		{"a page-property of a present page", pageProperty(page(1), "name", "Wed"), NoteChanged, NoteChanged},
		{"a page-property of the values a key holds", pageProperty(page(1), "name", "Mon"), NoEffect, NoEffect},
		{"a page-property on a removed page", pageProperty(page(2), "name", "Wed"), NoEffect, NoEffect},
		{"a page-property on an unknown page", pageProperty(page(9), "name", "Wed"), NoEffect, NoEffect},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, n := range []struct {
				note *StrokeBasedNote
				want Effect
			}{{NewStrokeBasedNote("c"), tc.want}, {NewHeaderFold("c"), tc.fold}} {
				for _, r := range before {
					n.note.Apply(r)
				}
				if got := n.note.Apply(tc.rec); got != n.want {
					t.Errorf("keeping strokes %t: effect %d, want %d", n.note.keepStrokes, got, n.want)
				}
			}
		})
	}
	n := ReadStrokeBasedNote("c", jsonlOf(t, logOf(before...)))
	n.Apply(pageAdd(page(2), 1, nil, link.BoundsFixed))
	if got := shape(n); got != "p1[- fixed]:1 p2[- fixed]:2" || n.Pages()[1].Name() != "Tue" {
		t.Errorf("a restored page holds %q, named %q", got, n.Pages()[1].Name())
	}
}

// The note's and each page's properties are what the last record of each key left, a key of no
// values removed, a key this Sieve does not know kept, in the replay and in the header fold alike.
func TestReplayKeepsTheNoteAndPageProperties(t *testing.T) {
	base := []link.Record{header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed), pageAdd(page(2), 1, nil, link.BoundsFixed)}
	for _, tc := range []struct {
		name  string
		ops   []link.Record
		note  string
		pages string
	}{
		{"none", nil, "map[]", "[map[] map[]]"},
		{"the last record of a key wins", []link.Record{noteProperty("type", "diary"), noteProperty("period", "2026-10"),
			noteProperty("period", "2026-11"), pageProperty(page(2), "name", "a"), pageProperty(page(2), "name", "b")},
			"map[period:[2026-11] type:[diary]]", "[map[] map[name:[b]]]"},
		{"no values remove a key", []link.Record{noteProperty("type", "diary"), noteProperty("type"),
			pageProperty(page(1), "name", "a"), pageProperty(page(1), "name")}, "map[]", "[map[] map[]]"},
		{"unknown keys are kept", []link.Record{noteProperty("x.later-key", "1", "2"), pageProperty(page(1), "colour", "red")},
			"map[x.later-key:[1 2]]", "[map[colour:[red]] map[]]"},
		{"a page not present is a no-op", []link.Record{pageRemove(page(2)), pageProperty(page(2), "name", "a"),
			pageAdd(page(2), 1, nil, link.BoundsFixed)}, "map[]", "[map[] map[]]"},
		{"a removed page keeps its properties", []link.Record{pageProperty(page(2), "name", "a"), pageRemove(page(2)),
			pageAdd(page(2), 1, nil, link.BoundsFixed)}, "map[]", "[map[] map[name:[a]]]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := logOf(append(append([]link.Record(nil), base...), tc.ops...)...)
			fold := NewHeaderFold("c")
			for _, r := range log {
				fold.Apply(r)
			}
			for _, n := range []*StrokeBasedNote{ReadStrokeBasedNote("c", jsonlOf(t, log)), fold} {
				var pages []Properties
				for _, p := range n.Pages() {
					pages = append(pages, p.Properties)
				}
				if got := fmt.Sprint(n.Properties()); got != tc.note {
					t.Errorf("note properties %s, want %s", got, tc.note)
				}
				if got := fmt.Sprint(pages); got != tc.pages {
					t.Errorf("page properties %s, want %s", got, tc.pages)
				}
			}
		})
	}
}

func TestReadStopsAtTheFirstLineThatDoesNotFollow(t *testing.T) {
	good := strokesLog(3)
	whole := jsonlOf(t, good)
	gapped := jsonlOf(t, append(append([]link.Record(nil), good[:3]...), good[4]))
	for _, tc := range []struct {
		name     string
		asset    []byte
		seq      uint32
		readUpTo int
	}{
		{"a whole log", whole, 5, len(whole)},
		{"an empty asset", nil, 0, 0},
		{"a line that does not parse", append(append([]byte(nil), jsonlOf(t, good[:2])...), "{\"seq\":3,\"op\":\"nope\"}\n"+string(jsonlOf(t, good[2:]))...), 2, len(jsonlOf(t, good[:2]))},
		{"a gap", gapped, 3, len(jsonlOf(t, good[:3]))},
		{"a last line without its newline", whole[:len(whole)-1], 4, len(jsonlOf(t, good[:4]))},
		{"a torn last line", whole[:len(whole)-10], 4, len(jsonlOf(t, good[:4]))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := NewStrokeBasedNote("c")
			cursor, read := n.Read(tc.asset)
			if cursor.Seq != tc.seq || read != tc.readUpTo {
				t.Errorf("read to seq %d, %d bytes; want %d, %d", cursor.Seq, read, tc.seq, tc.readUpTo)
			}
			if cursor != chainOf(t, good[:tc.seq]) {
				t.Error("the cursor's chain is not the log's")
			}
			if strokes := max(0, int(tc.seq)-2); len(n.Strokes(0)) != strokes {
				t.Errorf("%d strokes replayed, want %d", len(n.Strokes(0)), strokes)
			}
		})
	}
}

// The export page has the fixtures' keys and nesting, plus the device, the note's properties and
// the page where a fixture has none of them, which are written whether or not the note and page have
// properties. A properties object's keys are its data, so are not compared.
func TestExportPageHasTheFixturesShape(t *testing.T) {
	n := ReadStrokeBasedNote("c", jsonlOf(t, logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsUnbounded),
		strokeAdd(page(1), stroke(1), aPoint, offSheet), pageAdd(page(2), 1, nil, link.BoundsUnbounded),
		noteProperty("type", "diary"), noteProperty("period", "2026-11"), pageProperty(page(2), "name", "2026-11-20"))))
	exported, err := n.ExportPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := n.ExportPage(2); err == nil {
		t.Error("a page out of range exported")
	}
	ours := keysOf(t, exported)
	fixtures, _ := filepath.Glob("../../docs/design/specs/assets/*/boox-page-strokes.json")
	if len(fixtures) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range fixtures {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		theirs := keysOf(t, raw)
		for path, keys := range map[string][]string{"note": {"device", "properties"}, "": {"page"}, "page": {"id", "properties"}} {
			for _, key := range keys {
				if !slices.Contains(theirs[path], key) {
					theirs[path] = append(theirs[path], key)
				}
			}
			sort.Strings(theirs[path])
		}
		delete(theirs, "note.properties")
		delete(theirs, "page.properties")
		for path, keys := range theirs {
			if fmt.Sprint(ours[path]) != fmt.Sprint(keys) {
				t.Errorf("%s: %s has %v, ours %v", f, path, keys, ours[path])
			}
		}
	}
	var page struct {
		Note struct {
			Created    string
			PageAspect float32
			Template   *json.RawMessage
		}
		Strokes []struct {
			Points []struct{ X, Y, Size float32 }
		}
	}
	if err := json.Unmarshal(exported, &page); err != nil {
		t.Fatal(err)
	}
	if page.Note.Created != "2023-11-14T22:13:20Z" || page.Note.PageAspect != 0.75 ||
		string(*page.Note.Template) != `{"id":"ruled","params":{"spacing":0.05,"margin":0.12}}` {
		t.Errorf("note %+v template %s", page.Note, *page.Note.Template)
	}
	if p := page.Strokes[0].Points[1]; p.X != -1.5 || p.Y != -2.25 || p.Size != 0 {
		t.Errorf("point %+v", p)
	}
	for at, want := range []string{
		`"properties":{"period":["2026-11"],"type":["diary"]}},"page":{"id":"019a0000-0000-7000-8000-000000000011","properties":{}},"strokes":[{`,
		`"properties":{"period":["2026-11"],"type":["diary"]}},"page":{"id":"019a0000-0000-7000-8000-000000000012","properties":{"name":["2026-11-20"]}},"strokes":[]}`,
	} {
		exported, err := n.ExportPage(at)
		if err != nil || !strings.Contains(string(exported), want) {
			t.Errorf("page %d exports %s, %v; want it to hold %s", at, exported, err, want)
		}
	}

	bare, _ := ReadStrokeBasedNote("c", jsonlOf(t, logOf(header("n"), pageAdd(testID(0x11), 0, nil, link.BoundsFixed)))).ExportPage(0)
	if !strings.Contains(string(bare), `"properties":{}},"page":{"id":"019a0000-0000-7000-8000-000000000011","properties":{}},"strokes":[]}`) {
		t.Errorf("a page of a note without properties exports %s", bare)
	}
}

// Each page exports the template it is drawn with: its own, or the note default when it has none.
func TestExportPageCarriesTheTemplateThePageIsDrawnWith(t *testing.T) {
	grid := &link.Template{ID: "grid", Params: []link.TemplateParam{{Name: "pitch", Value: 0.05}}}
	n := ReadStrokeBasedNote("c", jsonlOf(t, logOf(header("n"), pageAdd(page(1), 0, grid, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), pageAdd(page(3), 2, nil, link.BoundsFixed), pageTemplate(page(3), dots))))
	for _, tc := range []struct {
		name string
		page int
		want string
	}{
		{"a page added with its own template", 0, `{"id":"grid","params":{"pitch":0.05}}`},
		{"a page with a null template", 1, `{"id":"ruled","params":{"spacing":0.05,"margin":0.12}}`},
		{"a page whose template a page-template changed", 2, `{"id":"dots","params":{"pitch":0.025}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exported, err := n.ExportPage(tc.page)
			if err != nil {
				t.Fatal(err)
			}
			var got struct {
				Note struct{ Template json.RawMessage }
			}
			if err := json.Unmarshal(exported, &got); err != nil {
				t.Fatal(err)
			}
			if string(got.Note.Template) != tc.want {
				t.Errorf("template %s, want %s", got.Note.Template, tc.want)
			}
		})
	}
}

// A page's key is the same for the same page on every run, and another for any change to what is
// drawn on it or for another page; what the note says of itself and not of the page leaves it
// alone, but for a diary page's heading, which is drawn on it. The pinned key is what any machine
// computes for that page.
func TestPageKeyNamesWhatIsOnThePage(t *testing.T) {
	keyOf := func(t *testing.T, at int, ops ...link.Record) string {
		t.Helper()
		key, err := ReadStrokeBasedNote("c", jsonlOf(t, logOf(append([]link.Record(nil), ops...)...))).PageKey(at)
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	base := []link.Record{header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1))}
	with := func(ops ...link.Record) []link.Record { return append(append([]link.Record(nil), base...), ops...) }
	moved := strokeAdd(page(1), stroke(1), offSheet)
	withHeader := func(change func(*link.Record)) link.Record {
		h := header("n")
		change(&h)
		return h
	}
	baseKey := keyOf(t, 0, base...)
	if baseKey != "f5ebbae77fa15fef" {
		t.Errorf("the page's key is %s on this machine", baseKey)
	}
	for _, tc := range []struct {
		name string
		page int
		ops  []link.Record
		same bool
	}{
		{"the same page replayed again", 0, with(), true},
		{"a stroke on another page", 0, with(strokeAdd(page(2), stroke(2))), true},
		{"a stroke added", 0, with(strokeAdd(page(1), stroke(2))), false},
		{"a stroke removed", 0, with(strokeRemove(page(1), stroke(1))), false},
		{"a stroke changed", 0, append([]link.Record{base[0], base[1], base[2]}, moved), false},
		{"another template", 0, with(pageTemplate(page(1), dots)), false},
		{"another note template under a page that has none", 0, with(withHeader(func(h *link.Record) { h.Template = dots })), false},
		{"another page aspect", 0, with(withHeader(func(h *link.Record) { h.PageAspect = 0.5 })), false},
		{"another title", 0, with(header("renamed")), true},
		{"another device", 0, with(withHeader(func(h *link.Record) { h.Device = link.Device{ID: "other", Name: "Tab Ultra"} })), true},
		{"another created time", 0, with(withHeader(func(h *link.Record) { h.CreatedMillis++ })), true},
		{"a note property", 0, with(noteProperty("type", "diary")), true},
		{"a page name", 0, with(pageProperty(page(1), "name", "2026-11-20")), true},
		{"a diary page named by no date", 0, with(noteProperty("type", "diary"), pageProperty(page(1), "name", "Kitchen")), true},
		{"a diary page named by a date", 0, with(noteProperty("type", "diary"), pageProperty(page(1), "name", "2026-11-20")), false},
		{"the same ink on an unbounded page", 0, []link.Record{base[0], pageAdd(page(1), 0, nil, link.BoundsUnbounded),
			base[2], base[3]}, false},
		{"another page with the same ink", 1, append([]link.Record{base[0], base[1], base[2]}, strokeAdd(page(2), stroke(1))), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := keyOf(t, tc.page, tc.ops...)
			if len(got) != 16 || strings.Trim(got, "0123456789abcdef") != "" {
				t.Fatalf("key %q is not 16 lowercase hex digits", got)
			}
			if (got == baseKey) != tc.same {
				t.Errorf("key %s, base %s, same = %v", got, baseKey, tc.same)
			}
		})
	}
	diaryDay := func(name string) string {
		return keyOf(t, 0, with(noteProperty("type", "diary"), pageProperty(page(1), "name", name))...)
	}
	if diaryDay("2026-11-20") == diaryDay("2026-11-21") {
		t.Error("a diary page has the same key named by another date")
	}
	if _, err := ReadStrokeBasedNote("c", jsonlOf(t, logOf(base...))).PageKey(2); err == nil {
		t.Error("a page out of range has a key")
	}
}

// A page is headed with its name's date in full when its note is a diary and the name is an ISO
// date, and otherwise has no heading.
func TestPageHeadingIsADiaryPageDate(t *testing.T) {
	for _, tc := range []struct {
		name string
		ops  []link.Record
		at   int
		want string
	}{
		{"a diary page named by a date", []link.Record{noteProperty("type", "diary"), pageProperty(page(1), "name", "2026-11-21")}, 0, "Saturday 21 November 2026"},
		{"a day with no leading zero", []link.Record{noteProperty("type", "diary"), pageProperty(page(1), "name", "2027-01-01")}, 0, "Friday 1 January 2027"},
		{"a diary page named by no date", []link.Record{noteProperty("type", "diary"), pageProperty(page(1), "name", "Kitchen")}, 0, ""},
		{"a day not in its month", []link.Record{noteProperty("type", "diary"), pageProperty(page(1), "name", "2026-02-30")}, 0, ""},
		{"a date not in the strict form", []link.Record{noteProperty("type", "diary"), pageProperty(page(1), "name", "2026-11-2")}, 0, ""},
		{"an unnamed diary page", []link.Record{noteProperty("type", "diary")}, 0, ""},
		{"a notebook page named by a date", []link.Record{pageProperty(page(1), "name", "2026-11-21")}, 0, ""},
		{"a note of two types", []link.Record{noteProperty("type", "diary", "other"), pageProperty(page(1), "name", "2026-11-21")}, 0, ""},
		{"a page out of range", []link.Record{noteProperty("type", "diary")}, 1, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ops := append([]link.Record{header("n"), pageAdd(page(1), 0, nil, link.BoundsFixed)}, tc.ops...)
			if got := ReadStrokeBasedNote("c", jsonlOf(t, logOf(ops...))).PageHeading(tc.at); got != tc.want {
				t.Errorf("heading %q, want %q", got, tc.want)
			}
		})
	}
}

// keysOf maps "", "note", "note.device", "strokes", "strokes.points" to their sorted keys.
func keysOf(t *testing.T, raw []byte) map[string][]string {
	t.Helper()
	var page map[string]interface{}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	var walk func(path string, v interface{})
	walk = func(path string, v interface{}) {
		switch v := v.(type) {
		case map[string]interface{}:
			for k, child := range v {
				out[path] = append(out[path], k)
				walk(strings.TrimPrefix(path+"."+k, "."), child)
			}
			sort.Strings(out[path])
		case []interface{}:
			if len(v) > 0 {
				walk(path, v[0])
			}
		}
	}
	walk("", page)
	delete(out, "note.template")
	return out
}
