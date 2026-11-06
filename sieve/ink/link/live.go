package link

import (
	"encoding/binary"
	"fmt"
)

// LiveType is a §4.3 live record's type byte.
type LiveType byte

const (
	LiveClock  LiveType = 1
	LiveBegin  LiveType = 2
	LivePoint  LiveType = 3
	LiveEnd    LiveType = 4
	LiveRemove LiveType = 5
	LiveView   LiveType = 6
)

// liveSize is each live record's fixed size, type byte included.
var liveSize = [...]int{LiveClock: 7, LiveBegin: 19, LivePoint: 17, LiveEnd: 13, LiveRemove: 5, LiveView: 9}

// liveScale is page units × 32768, the scale of positions and origins on the live feed.
const liveScale = 32768.0

// LiveRecord is one decoded §4.3 record. Type selects which fields it carries; the others are zero:
//
//	clock   TabletMs, PageAspect (0 when no note is live)
//	begin   StrokeSeq, Tool, WidthClass, TabletMs, OriginX, OriginY
//	point   StrokeSeq, X, Y, Pressure, TiltX, TiltY, TabletMs
//	end     StrokeSeq, PointCount, TabletMs
//	remove  StrokeSeq
//	view    OriginX, OriginY
//
// Positions are page units. A point's X and Y are absolute: its stroke's BEGIN origin plus its own
// offset, or the offset alone when the BEGIN was not seen. A view's origin is the top-left of an
// unbounded page's window, which is UI state and never belongs in a replica. Tool is the byte as
// sent.
type LiveRecord struct {
	Type       LiveType
	StrokeSeq  uint32
	TabletMs   uint32
	PageAspect float64
	Tool       Tool
	WidthClass uint8
	OriginX    float64
	OriginY    float64
	X, Y       float64
	Pressure   float64
	TiltX      int8
	TiltY      int8
	PointCount uint32
}

// LiveDecoder turns INK frames into live records, keeping each open stroke's origin across frames.
// The zero LiveDecoder is ready to use.
type LiveDecoder struct {
	origins map[uint32][2]float64
}

// Feed decodes one INK frame's payload, which holds whole records only. An unknown type byte or a
// record cut short is an error: the stream has lost its framing and the link must drop.
func (d *LiveDecoder) Feed(b []byte) ([]LiveRecord, error) {
	var out []LiveRecord
	for len(b) > 0 {
		t := LiveType(b[0])
		if t < LiveClock || t > LiveView {
			return out, fmt.Errorf("unknown live record type %d", t)
		}
		if len(b) < liveSize[t] {
			return out, fmt.Errorf("a live record of type %d cut short", t)
		}
		out = append(out, d.decode(b[:liveSize[t]]))
		b = b[liveSize[t]:]
	}
	return out, nil
}

// decode reads one whole record whose type byte is valid.
func (d *LiveDecoder) decode(b []byte) LiveRecord {
	le := binary.LittleEndian
	r := LiveRecord{Type: LiveType(b[0])}
	switch r.Type {
	case LiveClock:
		r.TabletMs = le.Uint32(b[1:])
		r.PageAspect = float64(le.Uint16(b[5:])) / 10000
	case LiveBegin:
		r.StrokeSeq = le.Uint32(b[1:])
		r.Tool = Tool(b[5])
		r.WidthClass = b[6]
		r.TabletMs = le.Uint32(b[7:])
		r.OriginX = float64(int32(le.Uint32(b[11:]))) / liveScale
		r.OriginY = float64(int32(le.Uint32(b[15:]))) / liveScale
		if d.origins == nil {
			d.origins = map[uint32][2]float64{}
		}
		d.origins[r.StrokeSeq] = [2]float64{r.OriginX, r.OriginY}
	case LivePoint:
		r.StrokeSeq = le.Uint32(b[1:])
		origin := d.origins[r.StrokeSeq]
		r.X = origin[0] + float64(le.Uint16(b[5:]))/liveScale
		r.Y = origin[1] + float64(le.Uint16(b[7:]))/liveScale
		r.Pressure = float64(le.Uint16(b[9:])) / 65535
		r.TiltX = int8(b[11])
		r.TiltY = int8(b[12])
		r.TabletMs = le.Uint32(b[13:])
	case LiveEnd:
		r.StrokeSeq = le.Uint32(b[1:])
		r.PointCount = le.Uint32(b[5:])
		r.TabletMs = le.Uint32(b[9:])
		delete(d.origins, r.StrokeSeq)
	case LiveRemove:
		r.StrokeSeq = le.Uint32(b[1:])
	case LiveView:
		r.OriginX = float64(int32(le.Uint32(b[1:]))) / liveScale
		r.OriginY = float64(int32(le.Uint32(b[5:]))) / liveScale
	}
	return r
}
