package ink

import "sieve/sieve/ink/link"

// LiveMark is one live record about the stroke under the pen or a whiteboard's window, in page
// units. Type is one of LiveBegin, LivePoint, LiveEnd, LiveRemove and LiveView, and selects which
// fields it carries; the others are zero:
//
//	begin   Stroke, Tool, WidthClass, X and Y the stroke's origin
//	point   Stroke, X and Y its place, Pressure, TMillis, TiltX, TiltY
//	end     Stroke
//	remove  Stroke
//	view    X and Y the top-left of the window on an unbounded page
type LiveMark struct {
	Type link.LiveType
	// Stroke numbers the stroke within one connection to the companion; it is not its id.
	Stroke     uint32
	Tool       link.Tool
	WidthClass uint8
	X, Y       float64
	// Pressure is 0..1.
	Pressure float64
	// TMillis is milliseconds since the stroke's begin.
	TMillis      uint32
	TiltX, TiltY int8
}

// LivePen turns a link's decoded live records into marks: CLOCK is dropped, and a point is timed
// from its stroke's BEGIN. A point or END of a stroke whose BEGIN it has not seen is dropped, so a
// consumer joining mid-stroke draws from the next BEGIN. The zero LivePen is ready to use; it is
// not safe for concurrent use.
type LivePen struct {
	begins map[uint32]uint32
}

// Marks are records as marks, in order.
func (p *LivePen) Marks(records []link.LiveRecord) []LiveMark {
	var out []LiveMark
	for _, r := range records {
		switch r.Type {
		case link.LiveBegin:
			if p.begins == nil {
				p.begins = map[uint32]uint32{}
			}
			p.begins[r.StrokeSeq] = r.TabletMs
			out = append(out, LiveMark{Type: r.Type, Stroke: r.StrokeSeq, Tool: r.Tool, WidthClass: r.WidthClass, X: r.OriginX, Y: r.OriginY})
		case link.LivePoint:
			begin, seen := p.begins[r.StrokeSeq]
			if !seen {
				continue
			}
			out = append(out, LiveMark{Type: r.Type, Stroke: r.StrokeSeq, X: r.X, Y: r.Y, Pressure: r.Pressure,
				TMillis: r.TabletMs - begin, TiltX: r.TiltX, TiltY: r.TiltY})
		case link.LiveEnd:
			if _, seen := p.begins[r.StrokeSeq]; !seen {
				continue
			}
			delete(p.begins, r.StrokeSeq)
			out = append(out, LiveMark{Type: r.Type, Stroke: r.StrokeSeq})
		case link.LiveRemove:
			delete(p.begins, r.StrokeSeq)
			out = append(out, LiveMark{Type: r.Type, Stroke: r.StrokeSeq})
		case link.LiveView:
			out = append(out, LiveMark{Type: r.Type, X: r.OriginX, Y: r.OriginY})
		}
	}
	return out
}
