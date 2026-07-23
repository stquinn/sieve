package services

import (
	"bytes"
	"compress/flate"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sieve/sieve/domain"
	"strings"
	"testing"
)

// stubSettingsSource is a minimal test double for the settings-read surface
// PlantumlService needs (mirrors block.StatePort's LoadSettings shape without
// importing block — services must not import block, see package doc). Tests
// mutate .settings between calls to prove Render reads settings per-call
// rather than caching them at construction time.
type stubSettingsSource struct {
	settings domain.Settings
}

func (s *stubSettingsSource) LoadSettings() domain.Settings {
	return s.settings
}

// plantumlDecodeAlphabet mirrors plantumlAlphabet in plantuml_service.go. It is
// duplicated (not imported) deliberately: this test proves the encoder against
// PlantUML's own published reference vector independently of our production
// encode path, so it must not share code with it.
const plantumlDecodeAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

// decodePlantumlText reverses PlantumlService.encodeSource: variant-base64 decode
// then raw-DEFLATE inflate. Test-only — production never needs to decode its own
// encoded output.
func decodePlantumlText(t *testing.T, encoded string) string {
	t.Helper()
	rev := make(map[byte]byte, 64)
	for i := 0; i < len(plantumlDecodeAlphabet); i++ {
		rev[plantumlDecodeAlphabet[i]] = byte(i)
	}
	if len(encoded)%4 != 0 {
		t.Fatalf("encoded length %d is not a multiple of 4", len(encoded))
	}
	var raw bytes.Buffer
	for i := 0; i < len(encoded); i += 4 {
		c1 := rev[encoded[i]]
		c2 := rev[encoded[i+1]]
		c3 := rev[encoded[i+2]]
		c4 := rev[encoded[i+3]]
		b1 := (c1 << 2) | (c2 >> 4)
		b2 := ((c2 & 0xF) << 4) | (c3 >> 2)
		b3 := ((c3 & 0x3) << 6) | c4
		raw.WriteByte(b1)
		raw.WriteByte(b2)
		raw.WriteByte(b3)
	}
	r := flate.NewReader(&raw)
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("inflate failed: %v", err)
	}
	return string(out)
}

func TestPlantumlDecode_ReferenceVector(t *testing.T) {
	// Canonical "Bob -> Alice : hello" PlantUML text-encoding reference vector.
	// Proves our alphabet + bit-packing against PlantUML's own spec,
	// independent of our encoder implementation (deflate output is not
	// byte-identical across implementations, so we cannot assert our encoder
	// equals this string — only that decoding it yields the right source).
	//
	// NOTE: this reference string decodes to the bare diagram body, without
	// the @startuml/@enduml wrapper — confirmed independently via Python's
	// zlib.decompressobj(wbits=-15) (raw DEFLATE), which is authoritative:
	// decompression of a given valid DEFLATE bitstream is unique regardless
	// of which encoder produced it. The task brief that seeded this test
	// expected the wrapped form; that expectation was incorrect and is
	// corrected here (see task-2-report.md).
	const reference = "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000"
	const want = "Bob -> Alice : hello"

	got := decodePlantumlText(t, reference)
	if got != want {
		t.Errorf("decode(%q) = %q, want %q", reference, got, want)
	}
}

func TestPlantumlService_EncodeRoundTrip(t *testing.T) {
	svc := NewPlantumlService(&stubSettingsSource{})

	cases := []string{
		"@startuml\nBob -> Alice : hello\n@enduml",
		"@startuml\nclass Föö {\n  +bär(): `int`\n}\n@enduml",
		"@startuml\nAlice -> Bob : `code` and üñïçødé\n@enduml",
	}

	for _, source := range cases {
		encoded, err := svc.encodeSource(source)
		if err != nil {
			t.Fatalf("encodeSource(%q) error: %v", source, err)
		}
		got := decodePlantumlText(t, encoded)
		if got != source {
			t.Errorf("round-trip mismatch: encode/decode(%q) = %q", source, got)
		}
	}
}

// TestPlantumlService_EncodeGolden pins the encoder's current output for one
// source. compress/flate's output is an implementation detail of the Go
// stdlib version in use; if a future Go upgrade changes its deflate output,
// this test fails loudly so the pin (and the reference/round-trip tests
// above) can be re-verified rather than silently drifting.
func TestPlantumlService_EncodeGolden(t *testing.T) {
	svc := NewPlantumlService(&stubSettingsSource{})
	const source = "@startuml\nBob -> Alice : hello\n@enduml"
	const wantEncoded = "SYWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKifpSq11000__y0"

	got, err := svc.encodeSource(source)
	if err != nil {
		t.Fatalf("encodeSource error: %v", err)
	}
	if got != wantEncoded {
		t.Errorf("encodeSource(%q) = %q, want %q (pinned golden value; if compress/flate's output legitimately changed on a Go upgrade, re-pin after confirming decodePlantumlText(got) still equals source)", source, got, wantEncoded)
	}
	if decoded := decodePlantumlText(t, got); decoded != source {
		t.Fatalf("sanity check failed: decode(encodeSource(source)) = %q, want %q", decoded, source)
	}
}

func TestPlantumlService_Render_Success(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<svg>ok</svg>"))
	}))
	defer srv.Close()

	stub := &stubSettingsSource{settings: domain.Settings{Diagram: domain.DiagramSettings{PlantumlServer: srv.URL}}}
	svc := NewPlantumlService(stub)

	body, err := svc.Render("@startuml\nBob -> Alice : hello\n@enduml")
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if string(body) != "<svg>ok</svg>" {
		t.Errorf("Render body = %q, want %q", body, "<svg>ok</svg>")
	}
	if !strings.HasPrefix(gotPath, "/svg/") {
		t.Errorf("request path = %q, want prefix /svg/", gotPath)
	}
	encoded, _ := svc.encodeSource("@startuml\nBob -> Alice : hello\n@enduml")
	wantPath := "/svg/" + encoded
	if gotPath != wantPath {
		t.Errorf("request path = %q, want %q", gotPath, wantPath)
	}
}

func TestPlantumlService_Render_NonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	stub := &stubSettingsSource{settings: domain.Settings{Diagram: domain.DiagramSettings{PlantumlServer: srv.URL}}}
	svc := NewPlantumlService(stub)

	_, err := svc.Render("@startuml\n@enduml")
	if err == nil {
		t.Fatal("expected an error for non-200 response, got nil")
	}
	if !errors.Is(err, ErrPlantumlServerStatus) {
		t.Errorf("expected ErrPlantumlServerStatus, got %v", err)
	}
	if errors.Is(err, ErrPlantumlServerUnavailable) {
		t.Errorf("non-200 must not also match ErrPlantumlServerUnavailable, got %v", err)
	}
}

func TestPlantumlService_Render_UnreachableServer(t *testing.T) {
	// A syntactically valid URL that nothing is listening on: connection
	// refused, no live network dependency (loopback only), deterministic in CI.
	stub := &stubSettingsSource{settings: domain.Settings{Diagram: domain.DiagramSettings{PlantumlServer: "http://127.0.0.1:1"}}}
	svc := NewPlantumlService(stub)

	_, err := svc.Render("@startuml\n@enduml")
	if err == nil {
		t.Fatal("expected a transport error for an unreachable server, got nil")
	}
	if !errors.Is(err, ErrPlantumlServerUnavailable) {
		t.Errorf("expected ErrPlantumlServerUnavailable, got %v", err)
	}
}

func TestPlantumlService_Render_EmptyServerSetting(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	stub := &stubSettingsSource{settings: domain.Settings{Diagram: domain.DiagramSettings{PlantumlServer: ""}}}
	svc := NewPlantumlService(stub)

	_, err := svc.Render("@startuml\n@enduml")
	if err == nil {
		t.Fatal("expected a config error for an empty server setting, got nil")
	}
	if !errors.Is(err, ErrPlantumlServerUnavailable) {
		t.Errorf("expected ErrPlantumlServerUnavailable, got %v", err)
	}
	if hit {
		t.Error("empty server setting must not attempt any network call")
	}
}

func TestPlantumlService_Render_SettingsReadPerCall(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<svg>ok</svg>"))
	}))
	defer srv.Close()

	stub := &stubSettingsSource{settings: domain.Settings{Diagram: domain.DiagramSettings{PlantumlServer: ""}}}
	svc := NewPlantumlService(stub)

	// First call: no server configured yet -> config error, no request.
	if _, err := svc.Render("@startuml\n@enduml"); !errors.Is(err, ErrPlantumlServerUnavailable) {
		t.Fatalf("expected config error before settings change, got %v", err)
	}
	if len(gotPaths) != 0 {
		t.Fatalf("expected no request before settings change, got %d", len(gotPaths))
	}

	// Settings change between calls: server appears, next call must use it
	// without reconstructing the service.
	stub.settings.Diagram.PlantumlServer = srv.URL
	if _, err := svc.Render("@startuml\n@enduml"); err != nil {
		t.Fatalf("expected success after settings change, got %v", err)
	}
	if len(gotPaths) != 1 {
		t.Fatalf("expected exactly one request after settings change, got %d", len(gotPaths))
	}
}
