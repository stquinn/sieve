package link

import (
	"bytes"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestEveryRecordRoundTripsThroughBothCodecs(t *testing.T) {
	ruled := &Template{ID: "ruled", Params: []TemplateParam{{"spacing", 0.038}, {"margin", 0.12}}}
	cases := map[string]Record{}
	for _, r := range vectorRecords {
		cases["vector "+r.Op.String()] = r
	}
	for name, r := range map[string]Record{
		"header, created to the millisecond": {Seq: 7, Op: OpNoteHeader, Note: vectorNote, CreatedMillis: 1_700_000_000_123,
			Title: `A "quoted" <title> & ünïcode ✍`, PageAspect: 1404.0 / 1872.0, Template: ruled,
			Device: Device{ID: "d", Name: "Stephen's Boox", Model: "ONYX NoteAir2"}},
		"header, created before 1970":                             {Seq: 1, Op: OpNoteHeader, CreatedMillis: -1, PageAspect: 1, Device: Device{}},
		"header, created at the last millisecond RFC 3339 writes": {Seq: 1, Op: OpNoteHeader, CreatedMillis: latestCreated, PageAspect: 0.1},
		"header, created at the first":                            {Seq: 1, Op: OpNoteHeader, CreatedMillis: earliestCreated, PageAspect: 3.4028235e38},
		"page-add of a template without params, unbounded": {Seq: 2, Op: OpPageAdd, Page: vectorPage, Index: math.MaxUint32,
			Template: &Template{ID: "blank"}, Bounds: BoundsUnbounded},
		"page-add of a template with repeated params": {Seq: 2, Op: OpPageAdd, Page: vectorPage,
			Template: &Template{ID: "grid", Params: []TemplateParam{{"spacing", 0.04}, {"spacing", 1e-7}}}},
		"page-template of a template": {Seq: 9, Op: OpPageTemplate, Page: vectorPage, Template: &Template{ID: "dots", Params: []TemplateParam{{"spacing", 0.04}}}},
		"stroke-add, negative places and tilt": {Seq: math.MaxInt32, Op: OpStrokeAdd, Page: vectorPage, Stroke: vectorStroke,
			Tool: ToolPen, WidthClass: 1, StartMillis: math.MaxUint64, Points: []Point{
				{-1234.5678, -0.000001, 0, math.MaxUint32, -128, 127},
				{float32(math.Copysign(0, -1)), 1.0 / 3.0, 1, 0, 0, -1},
				{math.SmallestNonzeroFloat32, math.MaxFloat32, 0.1, 17, 90, -90},
			}},
		"stroke-add without points": {Seq: 3, Op: OpStrokeAdd, Page: vectorPage, Stroke: vectorStroke, Tool: ToolPencil, WidthClass: 2, Points: []Point{}},
	} {
		cases[name] = r
	}
	for name, r := range cases {
		t.Run(name, func(t *testing.T) {
			body, err := r.Body()
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := ParseBody(body)
			if err != nil {
				t.Fatal(err)
			}
			line, err := decoded.JSONLine()
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := ParseJSONLine(line)
			if err != nil {
				t.Fatalf("%s: %v", line, err)
			}
			again, err := parsed.Body()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(again, body) {
				t.Errorf("%s\n body %x\nagain %x", line, body, again)
			}
			if !reflect.DeepEqual(parsed, decoded) {
				t.Errorf("JSON Lines gave\n %+v\nthe body gave\n %+v", parsed, decoded)
			}
		})
	}
}

func TestJSONLinesAreWrittenInTheContractsForm(t *testing.T) {
	header := vectorRecords[0]
	header.CreatedMillis += 123
	header.Title = "<b>&"
	for _, c := range []struct {
		record Record
		line   string
	}{
		{vectorRecords[0], `{"seq":1,"op":"note-header","id":"019a0000-0000-7000-8000-000000000001","created":"2023-11-14T22:13:20Z","title":"","pageAspect":0.75,"template":{"id":"ruled","params":{"spacing":0.05,"margin":0.12}},"device":{"id":"device-id","name":"Note Air 2","model":"ONYX NoteAir2"}}`},
		{header, `{"seq":1,"op":"note-header","id":"019a0000-0000-7000-8000-000000000001","created":"2023-11-14T22:13:20.123Z","title":"<b>&","pageAspect":0.75,"template":{"id":"ruled","params":{"spacing":0.05,"margin":0.12}},"device":{"id":"device-id","name":"Note Air 2","model":"ONYX NoteAir2"}}`},
		{vectorRecords[1], `{"seq":2,"op":"page-add","page":"019a0000-0000-7000-8000-000000000002","index":0,"template":null,"bounds":"fixed"}`},
		{vectorRecords[2], `{"seq":3,"op":"stroke-add","page":"019a0000-0000-7000-8000-000000000002","id":"019a0000-0000-7000-8000-000000000003","tool":"pencil","widthClass":3,"startMillis":1234,"points":[[0.25,0.5,0.75,0,30,-30],[-1.5,2.25,1,3,30,-30]]}`},
		{vectorRecords[3], `{"seq":4,"op":"page-template","page":"019a0000-0000-7000-8000-000000000002","template":null}`},
		{vectorRecords[4], `{"seq":5,"op":"stroke-remove","page":"019a0000-0000-7000-8000-000000000002","id":"019a0000-0000-7000-8000-000000000003"}`},
		{vectorRecords[5], `{"seq":6,"op":"page-remove","page":"019a0000-0000-7000-8000-000000000002"}`},
		{Record{Seq: 2, Op: OpPageAdd, Page: vectorPage, Index: 1, Template: &Template{ID: "blank"}, Bounds: BoundsUnbounded},
			`{"seq":2,"op":"page-add","page":"019a0000-0000-7000-8000-000000000002","index":1,"template":{"id":"blank","params":{}},"bounds":"unbounded"}`},
	} {
		got, err := c.record.JSONLine()
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != c.line+"\n" {
			t.Errorf("\n got %s\nwant %s", got, c.line)
		}
	}
}

func TestParseJSONLineRejects(t *testing.T) {
	const page = `"page":"019a0000-0000-7000-8000-000000000002"`
	for _, c := range []struct{ name, line string }{
		{"an unknown op", `{"seq":6,"op":"page-move",` + page + `}`},
		{"an extra key", `{"seq":6,"op":"page-remove",` + page + `,"extra":1}`},
		{"keys out of order", `{"op":"page-remove","seq":6,` + page + `}`},
		{"a missing key", `{"seq":6,"op":"page-remove"}`},
		{"trailing data", `{"seq":6,"op":"page-remove",` + page + `} {}`},
		{"a seq out of range", `{"seq":4294967296,"op":"page-remove",` + page + `}`},
		{"a fractional seq", `{"seq":6.5,"op":"page-remove",` + page + `}`},
		{"a page that is not a uuid", `{"seq":6,"op":"page-remove","page":"019a0000000070008000000000000002"}`},
		{"unknown bounds", `{"seq":2,"op":"page-add",` + page + `,"index":0,"template":null,"bounds":"round"}`},
		{"an unknown tool", `{"seq":5,"op":"stroke-add",` + page + `,"id":"019a0000-0000-7000-8000-000000000003","tool":"brush","widthClass":1,"startMillis":0,"points":[]}`},
		{"a width out of range", `{"seq":5,"op":"stroke-add",` + page + `,"id":"019a0000-0000-7000-8000-000000000003","tool":"pen","widthClass":256,"startMillis":0,"points":[]}`},
		{"a point short of a field", `{"seq":5,"op":"stroke-add",` + page + `,"id":"019a0000-0000-7000-8000-000000000003","tool":"pen","widthClass":1,"startMillis":0,"points":[[0,0,0,0,0]]}`},
		{"a tilt out of range", `{"seq":5,"op":"stroke-add",` + page + `,"id":"019a0000-0000-7000-8000-000000000003","tool":"pen","widthClass":1,"startMillis":0,"points":[[0,0,0,0,128,0]]}`},
		{"a float beyond binary32", `{"seq":4,"op":"page-template",` + page + `,"template":{"id":"grid","params":{"spacing":1e39}}}`},
		{"a created time finer than a millisecond", `{"seq":1,"op":"note-header","id":"019a0000-0000-7000-8000-000000000001","created":"2023-11-14T22:13:20.1234Z","title":"","pageAspect":0.75,"template":null,"device":{"id":"","name":"","model":""}}`},
		{"a created time that is not RFC 3339", `{"seq":1,"op":"note-header","id":"019a0000-0000-7000-8000-000000000001","created":"1700000000000","title":"","pageAspect":0.75,"template":null,"device":{"id":"","name":"","model":""}}`},
		{"not JSON", `seq 6`},
	} {
		if r, err := ParseJSONLine([]byte(c.line)); err == nil {
			t.Errorf("%s: took %+v", c.name, r)
		}
	}
}

func TestParseBodyRejects(t *testing.T) {
	header, _ := vectorRecords[0].Body()
	stroke, _ := vectorRecords[2].Body()
	pageAdd, _ := vectorRecords[1].Body()
	with := func(body []byte, at int, b byte) []byte {
		out := append([]byte{}, body...)
		out[at] = b
		return out
	}
	titleAt := 1 + 4 + 16 + 8
	for _, c := range []struct {
		name string
		body []byte
	}{
		{"an unknown op", with(pageAdd, 0, 99)},
		{"a trailing byte", append(append([]byte{}, pageAdd...), 0)},
		{"a body cut short", pageAdd[:len(pageAdd)-1]},
		{"bounds 2", with(pageAdd, len(pageAdd)-1, 2)},
		{"a template flag of 2", with(pageAdd, len(pageAdd)-2, 2)},
		{"tool 2", with(stroke, 1+4+32, 2)},
		{"a title that is not UTF-8", append(append(append([]byte{}, header[:titleAt]...), 1, 0, 0xff), header[titleAt+2:]...)},
		{"a page aspect that is not finite", append(append(append([]byte{}, header[:titleAt+2]...), 0, 0, 0xc0, 0x7f), header[titleAt+6:]...)},
		{"more points than bytes", with(stroke, 1+4+32+2+8, 0xff)},
	} {
		if r, err := ParseBody(c.body); err == nil {
			t.Errorf("%s: took %+v", c.name, r)
		}
	}
}

func TestARecordThatNoCodecCanCarryIsNotEncoded(t *testing.T) {
	for _, c := range []struct {
		name   string
		record Record
	}{
		{"an unknown op", Record{Seq: 1, Op: 99}},
		{"a title too long for its prefix", Record{Seq: 1, Op: OpNoteHeader, Title: strings.Repeat("a", math.MaxUint16+1)}},
		{"a created time past RFC 3339's years", Record{Seq: 1, Op: OpNoteHeader, CreatedMillis: latestCreated + 1}},
		{"a NaN pressure", Record{Seq: 1, Op: OpStrokeAdd, Points: []Point{{Pressure: float32(math.NaN())}}}},
		{"tool 2", Record{Seq: 1, Op: OpStrokeAdd, Tool: 2}},
		{"too many params", Record{Seq: 1, Op: OpPageTemplate, Template: &Template{ID: "t", Params: make([]TemplateParam, 256)}}},
	} {
		if _, err := c.record.Body(); err == nil {
			t.Errorf("%s: a body was written", c.name)
		}
		if _, err := c.record.JSONLine(); err == nil {
			t.Errorf("%s: a JSON line was written", c.name)
		}
	}
}

func TestLogFrame(t *testing.T) {
	body, _ := vectorRecords[5].Body()
	frame := NewLogFrame(body)
	if got, err := frame.Body(); err != nil || !bytes.Equal(got, body) {
		t.Fatalf("%x, %v", got, err)
	}
	damaged := func(at int) LogFrame {
		out := append(LogFrame{}, frame...)
		out[at] ^= 1
		return out
	}
	for _, c := range []struct {
		name  string
		frame LogFrame
	}{
		{"a body failing its CRC", damaged(10)},
		{"a CRC that is wrong", damaged(len(frame) - 1)},
		{"a length that is wrong", damaged(0)},
		{"a frame cut short", frame[:len(frame)-1]},
		{"an empty body", NewLogFrame(nil)},
		{"no frame", nil},
	} {
		if _, err := c.frame.Body(); err == nil {
			t.Errorf("%s: taken", c.name)
		}
	}
}
