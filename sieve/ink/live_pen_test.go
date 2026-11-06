package ink

import (
	"encoding/binary"
	"fmt"
	"strings"
	"testing"

	"sieve/sieve/ink/link"
)

// liveFrame builds an INK frame payload of §4.3 records.
type liveFrame []byte

func (f liveFrame) clock(ms uint32, aspect uint16) liveFrame {
	f = append(f, byte(link.LiveClock))
	f = binary.LittleEndian.AppendUint32(f, ms)
	return binary.LittleEndian.AppendUint16(f, aspect)
}

func (f liveFrame) begin(stroke uint32, tool link.Tool, width uint8, ms uint32, ox, oy int32) liveFrame {
	f = append(f, byte(link.LiveBegin))
	f = binary.LittleEndian.AppendUint32(f, stroke)
	f = append(f, byte(tool), width)
	f = binary.LittleEndian.AppendUint32(f, ms)
	f = binary.LittleEndian.AppendUint32(f, uint32(ox))
	return binary.LittleEndian.AppendUint32(f, uint32(oy))
}

func (f liveFrame) point(stroke uint32, x, y, pressure uint16, tiltX, tiltY int8, ms uint32) liveFrame {
	f = append(f, byte(link.LivePoint))
	f = binary.LittleEndian.AppendUint32(f, stroke)
	f = binary.LittleEndian.AppendUint16(f, x)
	f = binary.LittleEndian.AppendUint16(f, y)
	f = binary.LittleEndian.AppendUint16(f, pressure)
	f = append(f, byte(tiltX), byte(tiltY))
	return binary.LittleEndian.AppendUint32(f, ms)
}

func (f liveFrame) end(stroke, points, ms uint32) liveFrame {
	f = append(f, byte(link.LiveEnd))
	f = binary.LittleEndian.AppendUint32(f, stroke)
	f = binary.LittleEndian.AppendUint32(f, points)
	return binary.LittleEndian.AppendUint32(f, ms)
}

func (f liveFrame) remove(stroke uint32) liveFrame {
	return binary.LittleEndian.AppendUint32(append(f, byte(link.LiveRemove)), stroke)
}

func (f liveFrame) view(ox, oy int32) liveFrame {
	f = binary.LittleEndian.AppendUint32(append(f, byte(link.LiveView)), uint32(ox))
	return binary.LittleEndian.AppendUint32(f, uint32(oy))
}

// The live feed reaches page units by §4.3's arithmetic: positions and origins over 32768, a
// point placed from its begin's origin, pressure over 65535, a point timed from its begin.
func TestLivePen_MarksAreInPageUnits(t *testing.T) {
	var frames [][]string
	var decoder link.LiveDecoder
	var pen LivePen
	for _, payload := range []liveFrame{
		liveFrame{}.clock(1000, 7500).
			begin(1, link.ToolPen, 2, 1000, 16384, 8192).
			point(1, 8192, 16384, 13107, 30, -30, 1016),
		liveFrame{}.point(1, 65535, 0, 65535, 0, 0, 1040).
			end(1, 2, 1050).
			begin(2, link.ToolPencil, 3, 0xfffffff0, -16384, -40960).
			point(2, 16384, 8192, 0, 0, 0, 0x10).
			remove(2).
			view(-98304, 49152),
		liveFrame{}.point(9, 1, 1, 1, 0, 0, 5).end(9, 1, 6).view(0, 0),
	} {
		records, err := decoder.Feed(payload)
		if err != nil {
			t.Fatal(err)
		}
		var lines []string
		for _, m := range pen.Marks(records) {
			lines = append(lines, fmt.Sprintf("%d s%d %s w%d (%g, %g) p%g t%d tilt%d/%d",
				m.Type, m.Stroke, m.Tool, m.WidthClass, m.X, m.Y, m.Pressure, m.TMillis, m.TiltX, m.TiltY))
		}
		frames = append(frames, lines)
	}
	want := [][]string{
		{
			"2 s1 pen w2 (0.5, 0.25) p0 t0 tilt0/0",
			"3 s1 pen w0 (0.75, 0.75) p0.2 t16 tilt30/-30",
		},
		{
			"3 s1 pen w0 (2.499969482421875, 0.25) p1 t40 tilt0/0",
			"4 s1 pen w0 (0, 0) p0 t0 tilt0/0",
			"2 s2 pencil w3 (-0.5, -1.25) p0 t0 tilt0/0",
			"3 s2 pen w0 (0, -1) p0 t32 tilt0/0",
			"5 s2 pen w0 (0, 0) p0 t0 tilt0/0",
			"6 s0 pen w0 (-3, 1.5) p0 t0 tilt0/0",
		},
		{"6 s0 pen w0 (0, 0) p0 t0 tilt0/0"},
	}
	for i := range want {
		if strings.Join(frames[i], "\n") != strings.Join(want[i], "\n") {
			t.Errorf("frame %d marks\n%s\nwant\n%s", i, strings.Join(frames[i], "\n"), strings.Join(want[i], "\n"))
		}
	}
}
