package link

import "testing"

// liveGolden is the stream SieveInk's LiveRecordTest encodes, one INK frame's worth.
var liveGolden = []byte{
	0x01, 0x78, 0x56, 0x34, 0x12, 0x65, 0x20,
	0x02, 0x07, 0x00, 0x00, 0x00, 0x01, 0x03, 0xe8, 0x03, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
	0x03, 0x07, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0xa0, 0xff, 0xff, 0x1e, 0x80, 0xe9, 0x03, 0x00, 0x00,
	0x04, 0x07, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xea, 0x03, 0x00, 0x00,
	0x05, 0x07, 0x00, 0x00, 0x00,
	0x06, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
}

func TestLiveDecoderGoldenStream(t *testing.T) {
	want := []LiveRecord{
		{Type: LiveClock, TabletMs: 305419896, PageAspect: 0.8293},
		{Type: LiveBegin, StrokeSeq: 7, TabletMs: 1000, Tool: ToolPencil, WidthClass: 3, OriginX: 1, OriginY: -2},
		{Type: LivePoint, StrokeSeq: 7, TabletMs: 1001, X: 1.5, Y: -0.75, Pressure: 1, TiltX: 30, TiltY: -128},
		{Type: LiveEnd, StrokeSeq: 7, TabletMs: 1002, PointCount: 1},
		{Type: LiveRemove, StrokeSeq: 7},
		{Type: LiveView, OriginX: 1, OriginY: -2},
	}
	var d LiveDecoder
	got, err := d.Feed(liveGolden)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("%d records", len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("record %d:\n got %+v\nwant %+v", i, got[i], want[i])
		}
	}
}

func TestLiveDecoderRejectsDamage(t *testing.T) {
	for _, c := range []struct {
		name   string
		stream []byte
	}{
		{"unknown type", []byte{9, 0, 0}},
		{"type zero", []byte{0}},
		{"cut short", []byte{byte(LivePoint), 1, 2, 3}},
		{"a view cut short", []byte{byte(LiveView), 1, 2, 3}},
	} {
		var d LiveDecoder
		if _, err := d.Feed(c.stream); err == nil {
			t.Errorf("%s: want an error", c.name)
		}
	}
}
