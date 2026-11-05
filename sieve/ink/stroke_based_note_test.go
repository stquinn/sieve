package ink

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

// The export page has the fixtures' keys and nesting, plus the device the contract adds.
func TestExportPageHasTheFixturesShape(t *testing.T) {
	n := ReadStrokeBasedNote("c", jsonlOf(t, logOf(header("n"), pageAdd(page(1), 0, nil, link.BoundsUnbounded),
		strokeAdd(page(1), stroke(1), aPoint, offSheet))))
	exported, err := n.ExportPage(0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := n.ExportPage(1); err == nil {
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
		theirs["note"] = append(theirs["note"], "device")
		sort.Strings(theirs["note"])
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
