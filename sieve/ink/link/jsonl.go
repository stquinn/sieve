package link

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"
)

// The two forms a created time is written in: whole seconds, or to the millisecond.
const (
	createdSeconds = "2006-01-02T15:04:05Z"
	createdMillis  = "2006-01-02T15:04:05.000Z"
)

// JSONLine encodes the record as one §4.1 line, followed by "\n": keys in the contract's order
// and no others, floats in their shortest round-tripping binary32 form, created as an RFC 3339
// UTC time carrying milliseconds only when they are not zero.
func (r Record) JSONLine() ([]byte, error) {
	if err := r.check(); err != nil {
		return nil, err
	}
	w := &jsonWriter{}
	w.begin('{')
	w.field("seq").uint(uint64(r.Seq))
	w.field("op").str(r.Op.String())
	switch r.Op {
	case OpNoteHeader:
		w.field("id").str(r.Note.String())
		w.field("created").created(r.CreatedMillis)
		w.field("title").str(r.Title)
		w.field("pageAspect").f32(r.PageAspect)
		w.field("template").template(r.Template)
		w.field("device").begin('{')
		w.field("id").str(r.Device.ID)
		w.field("name").str(r.Device.Name)
		w.field("model").str(r.Device.Model)
		w.end('}')
	case OpPageAdd:
		w.field("page").str(r.Page.String())
		w.field("index").uint(uint64(r.Index))
		w.field("template").template(r.Template)
		w.field("bounds").str(r.Bounds.String())
	case OpPageRemove:
		w.field("page").str(r.Page.String())
	case OpPageTemplate:
		w.field("page").str(r.Page.String())
		w.field("template").template(r.Template)
	case OpStrokeAdd:
		w.field("page").str(r.Page.String())
		w.field("id").str(r.Stroke.String())
		w.field("tool").str(r.Tool.String())
		w.field("widthClass").uint(uint64(r.WidthClass))
		w.field("startMillis").uint(r.StartMillis)
		w.field("points").begin('[')
		for _, p := range r.Points {
			w.elem().begin('[')
			w.elem().f32(p.X)
			w.elem().f32(p.Y)
			w.elem().f32(p.Pressure)
			w.elem().uint(uint64(p.TMillis))
			w.elem().int(int64(p.TiltX))
			w.elem().int(int64(p.TiltY))
			w.end(']')
		}
		w.end(']')
	case OpStrokeRemove:
		w.field("page").str(r.Page.String())
		w.field("id").str(r.Stroke.String())
	}
	w.end('}')
	w.b = append(w.b, '\n')
	return w.b, w.err
}

// ParseJSONLine decodes one §4.1 line, with or without its "\n". The keys must be exactly those
// of the record's op, in the contract's order; an unknown op, a missing or extra key, trailing
// data, an integer out of its field's range, or a created time finer than a millisecond does not
// decode.
func ParseJSONLine(line []byte) (Record, error) {
	in := newJSONReader(bytes.TrimSuffix(line, []byte("\n")))
	var r Record
	in.delim('{')
	in.key("seq")
	r.Seq = uint32(in.uint(32))
	in.key("op")
	name := in.str()
	for op, n := range opNames {
		if n == name {
			r.Op = op
		}
	}
	if in.err == nil && r.Op == 0 {
		return r, fmt.Errorf("unknown op %q", name)
	}
	switch r.Op {
	case OpNoteHeader:
		in.key("id")
		r.Note = in.id()
		in.key("created")
		r.CreatedMillis = in.created()
		in.key("title")
		r.Title = in.str()
		in.key("pageAspect")
		r.PageAspect = in.f32()
		in.key("template")
		r.Template = in.template()
		in.key("device")
		in.delim('{')
		in.key("id")
		r.Device.ID = in.str()
		in.key("name")
		r.Device.Name = in.str()
		in.key("model")
		r.Device.Model = in.str()
		in.delim('}')
	case OpPageAdd:
		in.key("page")
		r.Page = in.id()
		in.key("index")
		r.Index = uint32(in.uint(32))
		in.key("template")
		r.Template = in.template()
		in.key("bounds")
		switch b := in.str(); b {
		case BoundsFixed.String():
			r.Bounds = BoundsFixed
		case BoundsUnbounded.String():
			r.Bounds = BoundsUnbounded
		default:
			in.fail(fmt.Errorf("unknown bounds %q", b))
		}
	case OpPageRemove:
		in.key("page")
		r.Page = in.id()
	case OpPageTemplate:
		in.key("page")
		r.Page = in.id()
		in.key("template")
		r.Template = in.template()
	case OpStrokeAdd:
		in.key("page")
		r.Page = in.id()
		in.key("id")
		r.Stroke = in.id()
		in.key("tool")
		switch t := in.str(); t {
		case ToolPen.String():
			r.Tool = ToolPen
		case ToolPencil.String():
			r.Tool = ToolPencil
		default:
			in.fail(fmt.Errorf("unknown tool %q", t))
		}
		in.key("widthClass")
		r.WidthClass = uint8(in.uint(8))
		in.key("startMillis")
		r.StartMillis = in.uint(64)
		in.key("points")
		r.Points = in.points()
	case OpStrokeRemove:
		in.key("page")
		r.Page = in.id()
		in.key("id")
		r.Stroke = in.id()
	}
	in.delim('}')
	in.eof()
	if in.err != nil {
		return r, in.err
	}
	return r, r.check()
}

// jsonWriter appends compact JSON. A field or element after the first in its object or array is
// preceded by a comma.
type jsonWriter struct {
	b   []byte
	err error
}

func (w *jsonWriter) begin(d byte) *jsonWriter { w.b = append(w.b, d); return w }
func (w *jsonWriter) end(d byte)               { w.b = append(w.b, d) }

func (w *jsonWriter) elem() *jsonWriter {
	if last := w.b[len(w.b)-1]; last != '{' && last != '[' {
		w.b = append(w.b, ',')
	}
	return w
}

func (w *jsonWriter) field(name string) *jsonWriter {
	w.elem().str(name)
	w.b = append(w.b, ':')
	return w
}

func (w *jsonWriter) uint(v uint64) { w.b = strconv.AppendUint(w.b, v, 10) }
func (w *jsonWriter) int(v int64)   { w.b = strconv.AppendInt(w.b, v, 10) }

func (w *jsonWriter) str(s string) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil && w.err == nil {
		w.err = err
	}
	w.b = append(w.b, bytes.TrimSuffix(buf.Bytes(), []byte("\n"))...)
}

func (w *jsonWriter) f32(f float32) {
	text, err := json.Marshal(f)
	if err != nil && w.err == nil {
		w.err = err
	}
	w.b = append(w.b, text...)
}

func (w *jsonWriter) created(ms int64) {
	layout := createdMillis
	if ms%1000 == 0 {
		layout = createdSeconds
	}
	w.str(time.UnixMilli(ms).UTC().Format(layout))
}

func (w *jsonWriter) template(t *Template) {
	if t == nil {
		w.b = append(w.b, "null"...)
		return
	}
	w.begin('{')
	w.field("id").str(t.ID)
	w.field("params").begin('{')
	for _, p := range t.Params {
		w.field(p.Name).f32(p.Value)
	}
	w.end('}')
	w.end('}')
}

// jsonReader reads one JSON value token by token; the first error sticks.
type jsonReader struct {
	dec *json.Decoder
	err error
}

func newJSONReader(line []byte) *jsonReader {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	return &jsonReader{dec: dec}
}

func (in *jsonReader) fail(err error) {
	if in.err == nil {
		in.err = err
	}
}

func (in *jsonReader) token() json.Token {
	if in.err != nil {
		return nil
	}
	t, err := in.dec.Token()
	if err != nil {
		in.fail(fmt.Errorf("a JSON line: %w", err))
	}
	return t
}

func (in *jsonReader) delim(d json.Delim) {
	if t := in.token(); in.err == nil && t != d {
		in.fail(fmt.Errorf("a JSON line with %v where %v belongs", t, d))
	}
}

func (in *jsonReader) key(name string) {
	if t := in.token(); in.err == nil && t != name {
		in.fail(fmt.Errorf("a JSON line with %v where key %q belongs", t, name))
	}
}

func (in *jsonReader) str() string {
	t := in.token()
	s, ok := t.(string)
	if in.err == nil && !ok {
		in.fail(fmt.Errorf("a JSON line with %v where a string belongs", t))
	}
	return s
}

func (in *jsonReader) number() string {
	t := in.token()
	n, ok := t.(json.Number)
	if in.err == nil && !ok {
		in.fail(fmt.Errorf("a JSON line with %v where a number belongs", t))
	}
	return string(n)
}

func (in *jsonReader) uint(bits int) uint64 {
	n := in.number()
	if in.err != nil {
		return 0
	}
	v, err := strconv.ParseUint(n, 10, bits)
	if err != nil {
		in.fail(fmt.Errorf("a JSON line: %w", err))
	}
	return v
}

func (in *jsonReader) int(bits int) int64 {
	n := in.number()
	if in.err != nil {
		return 0
	}
	v, err := strconv.ParseInt(n, 10, bits)
	if err != nil {
		in.fail(fmt.Errorf("a JSON line: %w", err))
	}
	return v
}

func (in *jsonReader) f32() float32 {
	n := in.number()
	if in.err != nil {
		return 0
	}
	v, err := strconv.ParseFloat(n, 32)
	if err != nil {
		in.fail(fmt.Errorf("a JSON line: %w", err))
	}
	return float32(v)
}

func (in *jsonReader) id() ID {
	s := in.str()
	if in.err != nil {
		return ID{}
	}
	u, err := ParseID(s)
	if err != nil {
		in.fail(err)
	}
	return u
}

func (in *jsonReader) created() int64 {
	s := in.str()
	if in.err != nil {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		in.fail(fmt.Errorf("created: %w", err))
		return 0
	}
	if t.Nanosecond()%int(time.Millisecond) != 0 {
		in.fail(fmt.Errorf("created %q is finer than a millisecond", s))
	}
	return t.UnixMilli()
}

func (in *jsonReader) template() *Template {
	t := in.token()
	if in.err != nil || t == nil {
		return nil
	}
	if t != json.Delim('{') {
		in.fail(fmt.Errorf("a JSON line with %v where a template belongs", t))
		return nil
	}
	tpl := &Template{}
	in.key("id")
	tpl.ID = in.str()
	in.key("params")
	in.delim('{')
	for in.err == nil && in.dec.More() {
		name := in.str()
		tpl.Params = append(tpl.Params, TemplateParam{Name: name, Value: in.f32()})
	}
	in.delim('}')
	in.delim('}')
	return tpl
}

func (in *jsonReader) points() []Point {
	out := []Point{}
	in.delim('[')
	for in.err == nil && in.dec.More() {
		in.delim('[')
		p := Point{X: in.f32(), Y: in.f32(), Pressure: in.f32(), TMillis: uint32(in.uint(32)), TiltX: int8(in.int(8)), TiltY: int8(in.int(8))}
		in.delim(']')
		out = append(out, p)
	}
	in.delim(']')
	return out
}

// eof requires the value to have ended the line.
func (in *jsonReader) eof() {
	if in.err != nil {
		return
	}
	if _, err := in.dec.Token(); !errors.Is(err, io.EOF) {
		in.fail(errors.New("a JSON line with data after its record"))
	}
}
