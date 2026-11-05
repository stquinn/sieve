package link

import (
	"bytes"
	"testing"
)

func TestCursorTakesOnlyTheNextSeq(t *testing.T) {
	first, _ := vectorRecords[0].Body()
	second, _ := vectorRecords[1].Body()
	third, _ := vectorRecords[2].Body()
	var c Cursor
	if err := c.Accept(vectorRecords[0], first); err != nil {
		t.Fatal(err)
	}
	held := c
	for _, r := range []struct {
		name   string
		record Record
		body   []byte
	}{
		{"a repeat", vectorRecords[0], first},
		{"a gap", vectorRecords[2], third},
	} {
		if err := c.Accept(r.record, r.body); err == nil {
			t.Errorf("%s was taken", r.name)
		}
		if c != held {
			t.Errorf("%s moved the cursor to %+v", r.name, c)
		}
	}
	if err := c.Accept(vectorRecords[1], second); err != nil || c.Seq != 2 {
		t.Errorf("seq 2 after 1: %+v, %v", c, err)
	}
}

// A replica held as JSON Lines reaches the same chain as the binary log it came from.
func TestCursorReplaysJSONLinesToTheBinaryChain(t *testing.T) {
	var fromBinary, fromLines Cursor
	var lines bytes.Buffer
	for _, r := range vectorRecords {
		body, _ := r.Body()
		if err := fromBinary.Accept(r, body); err != nil {
			t.Fatal(err)
		}
		line, err := r.JSONLine()
		if err != nil {
			t.Fatal(err)
		}
		lines.Write(line)
	}
	for _, line := range bytes.SplitAfter(bytes.TrimSuffix(lines.Bytes(), []byte("\n")), []byte("\n")) {
		r, err := ParseJSONLine(line)
		if err != nil {
			t.Fatal(err)
		}
		body, err := r.Body()
		if err != nil {
			t.Fatal(err)
		}
		if err := fromLines.Accept(r, body); err != nil {
			t.Fatal(err)
		}
	}
	if fromLines != fromBinary {
		t.Errorf("JSON Lines reached %+v, the binary log %+v", fromLines, fromBinary)
	}
}
