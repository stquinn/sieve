package link

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The fixed inputs of testdata/vectors.txt, which SieveInk's SharedVectorsTest reads too. The file
// belongs to the contract: this suite reads it and never writes it.
var (
	vectorKeyText = "MFRG GZDF MZTW Q2LK"
	vectorCNonce  = []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f}
	vectorSNonce  = []byte{0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff}
	vectorNote    = ID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01}
	vectorPage    = ID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02}
	vectorStroke  = ID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03}
)

// vectorRecords is one log of each op; their bodies are body_1 to body_6.
var vectorRecords = []Record{
	{Seq: 1, Op: OpNoteHeader, Note: vectorNote, CreatedMillis: 1_700_000_000_000, PageAspect: 0.75,
		Template: &Template{ID: "ruled", Params: []TemplateParam{{"spacing", 0.05}, {"margin", 0.12}}},
		Device:   Device{ID: "device-id", Name: "Note Air 2", Model: "ONYX NoteAir2"}},
	{Seq: 2, Op: OpPageAdd, Page: vectorPage, Bounds: BoundsFixed},
	{Seq: 3, Op: OpStrokeAdd, Page: vectorPage, Stroke: vectorStroke, Tool: ToolPencil, WidthClass: 3, StartMillis: 1234,
		Points: []Point{{0.25, 0.5, 0.75, 0, 30, -30}, {-1.5, 2.25, 1, 3, 30, -30}}},
	{Seq: 4, Op: OpPageTemplate, Page: vectorPage},
	{Seq: 5, Op: OpStrokeRemove, Page: vectorPage, Stroke: vectorStroke},
	{Seq: 6, Op: OpPageRemove, Page: vectorPage},
}

// vectorFile is testdata/vectors.txt, remembering which entries a test has checked.
type vectorFile struct {
	values  map[string]string
	checked map[string]bool
}

func readVectorFile(t *testing.T) *vectorFile {
	t.Helper()
	f, err := os.Open("testdata/vectors.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	v := &vectorFile{values: map[string]string{}, checked: map[string]bool{}}
	lines := bufio.NewScanner(f)
	for lines.Scan() {
		if line := lines.Text(); line != "" && !strings.HasPrefix(line, "#") {
			name, value, _ := strings.Cut(line, " ")
			v.values[name] = value
		}
	}
	if err := lines.Err(); err != nil {
		t.Fatal(err)
	}
	return v
}

// expect checks that the file holds want under name.
func (v *vectorFile) expect(t *testing.T, name, want string) {
	t.Helper()
	got, ok := v.values[name]
	if !ok {
		t.Errorf("%s is not in the file", name)
	}
	v.checked[name] = true
	if got != want {
		t.Errorf("%s:\n file %s\n here %s", name, got, want)
	}
}

// bytes is the file's value under name, decoded from hex.
func (v *vectorFile) bytes(t *testing.T, name string) []byte {
	t.Helper()
	b, err := hex.DecodeString(v.values[name])
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return b
}

func (v *vectorFile) requireAllChecked(t *testing.T) {
	t.Helper()
	for name := range v.values {
		if !v.checked[name] {
			t.Errorf("vector %s is in the file but nothing here checks it", name)
		}
	}
}

func TestSharedVectors(t *testing.T) {
	v := readVectorFile(t)
	key, err := ParseKey(vectorKeyText)
	if err != nil {
		t.Fatal(err)
	}
	sessionKey, err := key.SessionKey(vectorCNonce, vectorSNonce)
	if err != nil {
		t.Fatal(err)
	}
	sl, err := newSealer(sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("a frame in the clear")
	proof := key.SieveProof(vectorCNonce)

	for _, c := range []struct{ name, value string }{
		{"key_text", strings.ReplaceAll(key.Text(), " ", "")},
		{"key_bytes", hex.EncodeToString(key[:])},
		{"sieve_id", key.SieveID()},
		{"c_nonce", hex.EncodeToString(vectorCNonce)},
		{"s_nonce", hex.EncodeToString(vectorSNonce)},
		{"sieve_proof", hex.EncodeToString(proof)},
		{"companion_proof", hex.EncodeToString(key.CompanionProof(vectorSNonce))},
		{"session_key", hex.EncodeToString(sessionKey)},
		{"plain", hex.EncodeToString(plain)},
		{"sealed_c2s_0", hex.EncodeToString(sl.seal(CompanionToSieve, 0, plain))},
		{"sealed_c2s_7", hex.EncodeToString(sl.seal(CompanionToSieve, 7, plain))},
		{"sealed_s2c_0", hex.EncodeToString(sl.seal(SieveToCompanion, 0, plain))},
	} {
		v.expect(t, c.name, c.value)
	}

	sealed := v.bytes(t, "sealed_c2s_7")
	if got, err := sl.open(CompanionToSieve, 7, sealed); err != nil || string(got) != string(plain) {
		t.Errorf("opening: %q, %v", got, err)
	}
	for _, c := range []struct {
		name      string
		direction Direction
		counter   uint64
	}{{"another counter", CompanionToSieve, 8}, {"another direction", SieveToCompanion, 7}} {
		if _, err := sl.open(c.direction, c.counter, sealed); err == nil {
			t.Errorf("%s opened", c.name)
		}
	}

	var cursor Cursor
	for i, rec := range vectorRecords {
		body, err := rec.Body()
		if err != nil {
			t.Fatalf("record %d: %v", i+1, err)
		}
		v.expect(t, fmt.Sprintf("body_%d", i+1), hex.EncodeToString(body))
		if parsed, err := ParseBody(body); err != nil || !reflect.DeepEqual(parsed, rec) {
			t.Errorf("body %d decodes to %+v, %v", i+1, parsed, err)
		}
		if err := cursor.Accept(rec, body); err != nil {
			t.Fatal(err)
		}
		v.expect(t, fmt.Sprintf("chain_%d", i+1), hex.EncodeToString(cursor.Hash[:]))
	}

	var hash [32]byte
	for i := range hash {
		hash[i] = byte(i)
	}
	pageAdd, _ := vectorRecords[1].Body()
	meta, err := Meta{vectorNote, "Título", []string{"k1", "k2"}, []string{"Work"}, "A line.", 6}.encode()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name  string
		frame []byte
	}{
		{"challenge", newFrame(frameChallenge).u8(protocolVersion).raw(vectorCNonce).b},
		{"hello", helloFrame{key.SieveID(), vectorSNonce, proof}.encode()},
		{"ok", newFrame(frameOK).raw(proof).b},
		{"refuse", newFrame(frameRefuse).id(vectorNote).string(RefuseNotOffered).b},
		{"list", listFrame{}.encode()},
		{"notes", newFrame(frameNotes).u32(1).id(vectorNote).string("").u32(3).u32(6).b},
		{"open", openFrame{vectorNote, 2}.encode()},
		{"head", newFrame(frameHead).id(vectorNote).u32(6).raw(hash[:]).b},
		{"op", newFrame(frameOp).id(vectorNote).raw(NewLogFrame(pageAdd)).b},
		{"ack", ackFrame{vectorNote, 6}.encode()},
		{"done", newFrame(frameDone).id(vectorNote).b},
		{"meta", meta},
		{"open-note", openNoteFrame{vectorNote}.encode()},
		{"live", newFrame(frameLive).id(vectorNote).id(vectorPage).b},
		{"ink", newFrame(frameInk).raw(liveGolden).b},
	} {
		v.expect(t, "frame_"+c.name, hex.EncodeToString(c.frame))
	}

	notes := &frameReader{b: v.bytes(t, "frame_notes")[1:]}
	if got := notes.notes(); notes.finish() != nil || !reflect.DeepEqual(got, []NoteEntry{{vectorNote, "", 3, 6}}) {
		t.Errorf("frame_notes decodes to %+v", got)
	}
	head := &frameReader{b: v.bytes(t, "frame_head")[1:]}
	if note, got := head.head(); head.finish() != nil || note != vectorNote || got != (headCheck{6, hash}) {
		t.Errorf("frame_head decodes to %s %+v", note, got)
	}
	if body, err := LogFrame(v.bytes(t, "frame_op")[17:]).Body(); err != nil || hex.EncodeToString(body) != v.values["body_2"] {
		t.Errorf("frame_op carries %x, %v", body, err)
	}

	v.requireAllChecked(t)
}

func TestParseKey(t *testing.T) {
	for _, c := range []struct {
		text string
		ok   bool
	}{
		{"MFRG GZDF MZTW Q2LK", true}, {"mfrg-gzdf-mztw-q2lk", true}, {"MFRGGZDFMZTWQ2LK", true}, {"MFRGGZDFMZTWQ2LK\n", true},
		{"MFRGGZDFMZTWQ2L", false}, {"MFRGGZDFMZTWQ2LKA", false}, {"MFRGGZDFMZTWQ2L1", false}, {"", false},
	} {
		if _, err := ParseKey(c.text); (err == nil) != c.ok {
			t.Errorf("%q: %v", c.text, err)
		}
	}
}

func TestNewKeyRoundTripsThroughItsText(t *testing.T) {
	k, err := NewKey()
	if err != nil {
		t.Fatal(err)
	}
	back, err := ParseKey(k.Text())
	if err != nil || back != k {
		t.Errorf("%q parses to %x, %v", k.Text(), back, err)
	}
}
