package link

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"math"
	"time"
	"unicode/utf8"
)

// Op is a log record's operation, as its §4.4 byte.
type Op byte

const (
	OpNoteHeader   Op = 16
	OpPageAdd      Op = 17
	OpPageRemove   Op = 18
	OpPageTemplate Op = 19
	OpStrokeAdd    Op = 20
	OpStrokeRemove Op = 21
)

var opNames = map[Op]string{
	OpNoteHeader:   "note-header",
	OpPageAdd:      "page-add",
	OpPageRemove:   "page-remove",
	OpPageTemplate: "page-template",
	OpStrokeAdd:    "stroke-add",
	OpStrokeRemove: "stroke-remove",
}

// String is the op's JSON Lines name, or a placeholder for an unknown op.
func (o Op) String() string {
	if name, ok := opNames[o]; ok {
		return name
	}
	return fmt.Sprintf("op(%d)", byte(o))
}

// Tool is a stroke's tool: 0 pen, 1 pencil.
type Tool byte

const (
	ToolPen    Tool = 0
	ToolPencil Tool = 1
)

func (t Tool) String() string {
	switch t {
	case ToolPen:
		return "pen"
	case ToolPencil:
		return "pencil"
	}
	return fmt.Sprintf("tool(%d)", byte(t))
}

// Bounds is a page's extent: 0 a fixed sheet, 1 an unbounded whiteboard.
type Bounds byte

const (
	BoundsFixed     Bounds = 0
	BoundsUnbounded Bounds = 1
)

func (b Bounds) String() string {
	switch b {
	case BoundsFixed:
		return "fixed"
	case BoundsUnbounded:
		return "unbounded"
	}
	return fmt.Sprintf("bounds(%d)", byte(b))
}

// Template is a TemplateRef: a template id and its params in the order they are encoded. A nil
// *Template is the null template. Names are not required to be unique; order is preserved by
// every codec.
type Template struct {
	ID     string
	Params []TemplateParam
}

// TemplateParam is one named length of a template, in page units.
type TemplateParam struct {
	Name  string
	Value float32
}

// Device is the device a note was written on, as its note-header names it.
type Device struct {
	ID, Name, Model string
}

// Point is one sample of a committed stroke.
type Point struct {
	X, Y, Pressure float32
	TMillis        uint32
	TiltX, TiltY   int8
}

// Record is one log record. Op selects which fields it carries; the others are zero:
//
//	note-header    Note, CreatedMillis, Title, PageAspect, Template, Device
//	page-add       Page, Index, Template, Bounds
//	page-remove    Page
//	page-template  Page, Template
//	stroke-add     Page, Stroke, Tool, WidthClass, StartMillis, Points
//	stroke-remove  Page, Stroke
//
// Every Record a codec here returns can be encoded by every other codec here, and a body decoded
// and encoded again, through either codec, is byte-identical.
type Record struct {
	Seq uint32
	Op  Op

	Note          ID
	CreatedMillis int64
	Title         string
	PageAspect    float32
	Template      *Template
	Device        Device

	Page   ID
	Index  uint32
	Bounds Bounds

	Stroke      ID
	Tool        Tool
	WidthClass  uint8
	StartMillis uint64
	Points      []Point
}

// maxLogBody is the longest body a log frame may declare.
const maxLogBody = 16 * 1024 * 1024

// pointBytes is one encoded Point.
const pointBytes = 18

// The Unix milliseconds an RFC 3339 timestamp can hold: years 0000 to 9999.
var (
	earliestCreated = time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	latestCreated   = time.Date(9999, 12, 31, 23, 59, 59, 999_000_000, time.UTC).UnixMilli()
)

// ParseBody decodes a record's §4.4 body. A body that is short, carries trailing bytes, an unknown
// op, a tool, bounds or template flag other than 0 or 1, a string that is not UTF-8, a float that
// is not finite, or a created time outside RFC 3339's years does not decode.
func ParseBody(body []byte) (Record, error) {
	in := &frameReader{b: body}
	r := Record{Op: Op(in.u8()), Seq: in.u32()}
	switch r.Op {
	case OpNoteHeader:
		r.Note = in.id()
		r.CreatedMillis = int64(in.u64())
		r.Title = in.text()
		r.PageAspect = in.f32()
		r.Template = in.template()
		r.Device = Device{ID: in.text(), Name: in.text(), Model: in.text()}
	case OpPageAdd:
		r.Page = in.id()
		r.Index = in.u32()
		r.Template = in.template()
		r.Bounds = Bounds(in.flag())
	case OpPageRemove:
		r.Page = in.id()
	case OpPageTemplate:
		r.Page = in.id()
		r.Template = in.template()
	case OpStrokeAdd:
		r.Page, r.Stroke = in.id(), in.id()
		r.Tool, r.WidthClass = Tool(in.flag()), in.u8()
		r.StartMillis = in.u64()
		count := in.u32()
		if uint64(count)*pointBytes > uint64(len(in.b)) {
			return r, fmt.Errorf("a stroke of %d points in %d bytes", count, len(in.b))
		}
		r.Points = make([]Point, count)
		for i := range r.Points {
			r.Points[i] = Point{X: in.f32(), Y: in.f32(), Pressure: in.f32(), TMillis: in.u32(), TiltX: int8(in.u8()), TiltY: int8(in.u8())}
		}
	case OpStrokeRemove:
		r.Page, r.Stroke = in.id(), in.id()
	default:
		return r, fmt.Errorf("unknown op %d", byte(r.Op))
	}
	if err := in.finish(); err != nil {
		return r, err
	}
	return r, r.check()
}

// Body encodes the record as its canonical §4.4 body.
func (r Record) Body() ([]byte, error) {
	if err := r.check(); err != nil {
		return nil, err
	}
	w := newFrame(byte(r.Op)).u32(r.Seq)
	switch r.Op {
	case OpNoteHeader:
		w.id(r.Note).u64(uint64(r.CreatedMillis)).string(r.Title).f32(r.PageAspect)
		r.Template.writeTo(w)
		w.string(r.Device.ID).string(r.Device.Name).string(r.Device.Model)
	case OpPageAdd:
		w.id(r.Page).u32(r.Index)
		r.Template.writeTo(w)
		w.u8(byte(r.Bounds))
	case OpPageRemove:
		w.id(r.Page)
	case OpPageTemplate:
		w.id(r.Page)
		r.Template.writeTo(w)
	case OpStrokeAdd:
		w.id(r.Page).id(r.Stroke).u8(byte(r.Tool)).u8(r.WidthClass).u64(r.StartMillis).u32(uint32(len(r.Points)))
		for _, p := range r.Points {
			w.f32(p.X).f32(p.Y).f32(p.Pressure).u32(p.TMillis).u8(byte(p.TiltX)).u8(byte(p.TiltY))
		}
	case OpStrokeRemove:
		w.id(r.Page).id(r.Stroke)
	}
	body, err := w.finish()
	if err == nil && len(body) > maxLogBody {
		err = fmt.Errorf("a body of %d bytes is over the limit of %d", len(body), maxLogBody)
	}
	return body, err
}

// check holds what every codec needs of a record to encode it so that it decodes the same.
func (r Record) check() error {
	if _, ok := opNames[r.Op]; !ok {
		return fmt.Errorf("unknown op %d", byte(r.Op))
	}
	if r.Tool > ToolPencil {
		return fmt.Errorf("unknown tool %d", byte(r.Tool))
	}
	if r.Bounds > BoundsUnbounded {
		return fmt.Errorf("unknown bounds %d", byte(r.Bounds))
	}
	if r.CreatedMillis < earliestCreated || r.CreatedMillis > latestCreated {
		return fmt.Errorf("created %d ms is outside the years RFC 3339 can write", r.CreatedMillis)
	}
	floats := []float32{r.PageAspect}
	texts := []string{r.Title, r.Device.ID, r.Device.Name, r.Device.Model}
	if r.Template != nil {
		if len(r.Template.Params) > math.MaxUint8 {
			return fmt.Errorf("a template of %d params is over the limit of %d", len(r.Template.Params), math.MaxUint8)
		}
		texts = append(texts, r.Template.ID)
		for _, p := range r.Template.Params {
			texts = append(texts, p.Name)
			floats = append(floats, p.Value)
		}
	}
	for _, p := range r.Points {
		floats = append(floats, p.X, p.Y, p.Pressure)
	}
	for _, f := range floats {
		if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
			return errors.New("a record holding a float that is not finite")
		}
	}
	for _, s := range texts {
		if !utf8.ValidString(s) {
			return errors.New("a record holding a string that is not UTF-8")
		}
		if len(s) > math.MaxUint16 {
			return fmt.Errorf("a string of %d bytes is over the limit of %d", len(s), math.MaxUint16)
		}
	}
	return nil
}

// writeTo encodes the template, or null when t is nil.
func (t *Template) writeTo(w *frameWriter) {
	if t == nil {
		w.u8(0)
		return
	}
	w.u8(1).string(t.ID).u8(byte(len(t.Params)))
	for _, p := range t.Params {
		w.string(p.Name).f32(p.Value)
	}
}

// template reads a template, nil for null.
func (r *frameReader) template() *Template {
	if r.flag() == 0 {
		return nil
	}
	t := &Template{ID: r.text()}
	for n := r.u8(); n > 0 && !r.bad; n-- {
		t.Params = append(t.Params, TemplateParam{Name: r.text(), Value: r.f32()})
	}
	return t
}

// LogFrame is one record as the device's log and an OP frame carry it: length u32, body, then
// the CRC-32 (IEEE) of the body, all little-endian.
type LogFrame []byte

// NewLogFrame frames a body.
func NewLogFrame(body []byte) LogFrame {
	b := binary.LittleEndian.AppendUint32(make([]byte, 0, len(body)+8), uint32(len(body)))
	return binary.LittleEndian.AppendUint32(append(b, body...), crc32.ChecksumIEEE(body))
}

// Body checks the frame's length and CRC and returns its body.
func (f LogFrame) Body() ([]byte, error) {
	if len(f) < 8 {
		return nil, fmt.Errorf("a log frame of %d bytes", len(f))
	}
	length := binary.LittleEndian.Uint32(f)
	if length == 0 || length > maxLogBody || uint64(len(f)) != uint64(length)+8 {
		return nil, fmt.Errorf("a log frame of %d bytes declaring a body of %d", len(f), length)
	}
	body := f[4 : 4+length]
	if binary.LittleEndian.Uint32(f[4+length:]) != crc32.ChecksumIEEE(body) {
		return nil, errors.New("a log frame failing its CRC")
	}
	return body, nil
}
