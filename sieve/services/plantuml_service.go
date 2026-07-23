package services

import (
	"bytes"
	"compress/flate"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sieve/sieve/domain"
	"strings"
	"time"
)

// ErrPlantumlServerUnavailable means there is no usable PlantUML server to talk
// to: the configured server setting is empty/unparseable, or the HTTP request
// to it could not complete (DNS/dial/transport failure). Both are
// configuration-or-connectivity problems from the caller's perspective, as
// distinct from ErrPlantumlServerStatus below (a server that IS reachable but
// answered with a non-200 status).
var ErrPlantumlServerUnavailable = errors.New("plantuml: no usable server")

// ErrPlantumlServerStatus means the PlantUML server responded, but not with
// 200 OK. Note: the public PlantUML server returns SVG *error drawings* with
// status 200 for PlantUML syntax errors — that is a SUCCESS path (the drawing
// is meant to be displayed), never this error.
var ErrPlantumlServerStatus = errors.New("plantuml: server returned non-200 status")

// plantumlAlphabet is PlantUML's base64 variant: standard 3-byte-to-4-char bit
// packing, but over this 64-character alphabet instead of RFC 4648's, and
// zero-padding incomplete trailing byte groups instead of '='-padding them.
const plantumlAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

// settingsSource is the minimal settings-read surface PlantumlService needs.
// It mirrors block.StatePort's LoadSettings method structurally — services
// must not import block (block imports services-shaped ports, not the other
// way — see block/ports.go) — so this stays a small local interface rather
// than a dependency on the port type. *StateService satisfies it as-is; tests
// supply a stub that lets settings change between calls.
type settingsSource interface {
	LoadSettings() domain.Settings
}

// PlantumlService is the PlantUML rendering surface: encodes source text into
// PlantUML's URL-safe representation and fetches the rendered SVG from the
// configured server. It implements block.PlantumlPort. The server URL is read
// from settings on every Render call (not cached), so a settings change takes
// effect without restarting the app. The v1 backend is HTTP; a local
// `plantuml.jar -pipe -tsvg` backend can replace the fetch behind this same
// Render method without touching callers.
type PlantumlService struct {
	settings settingsSource
	client   *http.Client
}

// NewPlantumlService constructs a PlantumlService backed by settings. The HTTP
// client is built once and reused across calls (not per-request).
func NewPlantumlService(settings settingsSource) *PlantumlService {
	return &PlantumlService{
		settings: settings,
		client:   &http.Client{Timeout: 20 * time.Second},
	}
}

// Render fetches the SVG rendering of source from the configured PlantUML
// server. Errors are one of two sentinel classes (test with errors.Is):
// ErrPlantumlServerUnavailable (no/bad server config, or transport failure)
// or ErrPlantumlServerStatus (server reachable, non-200 response).
func (s *PlantumlService) Render(source string) ([]byte, error) {
	serverURL := strings.TrimSpace(s.settings.LoadSettings().Diagram.PlantumlServer)
	if serverURL == "" {
		return nil, fmt.Errorf("%w: no server configured", ErrPlantumlServerUnavailable)
	}
	parsed, err := url.Parse(serverURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%w: invalid server URL %q", ErrPlantumlServerUnavailable, serverURL)
	}

	encoded, err := s.encodeSource(source)
	if err != nil {
		return nil, fmt.Errorf("plantuml: failed to encode source: %w", err)
	}
	fetchURL := strings.TrimRight(serverURL, "/") + "/svg/" + encoded

	resp, err := s.client.Get(fetchURL)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlantumlServerUnavailable, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrPlantumlServerStatus, resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlantumlServerUnavailable, err)
	}
	return body, nil
}

// encodeSource is PlantUML's text-encoding scheme: UTF-8 bytes -> raw DEFLATE
// (best compression, no zlib header, via compress/flate) -> plantumlBase64.
func (s *PlantumlService) encodeSource(source string) (string, error) {
	var buf bytes.Buffer
	w, err := flate.NewWriter(&buf, flate.BestCompression)
	if err != nil {
		return "", err
	}
	if _, err := w.Write([]byte(source)); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return s.plantumlBase64(buf.Bytes()), nil
}

// plantumlBase64 encodes data using PlantUML's base64 variant: the same
// 3-byte-to-4-char bit packing as standard base64, over plantumlAlphabet,
// treating any missing bytes in the final incomplete group as zero (rather
// than RFC 4648's '=' padding) — see plantumlAlphabet's doc comment.
func (s *PlantumlService) plantumlBase64(data []byte) string {
	var sb strings.Builder
	for i := 0; i < len(data); i += 3 {
		var b1, b2, b3 byte
		b1 = data[i]
		if i+1 < len(data) {
			b2 = data[i+1]
		}
		if i+2 < len(data) {
			b3 = data[i+2]
		}
		sb.WriteByte(plantumlAlphabet[b1>>2])
		sb.WriteByte(plantumlAlphabet[((b1&0x3)<<4)|(b2>>4)])
		sb.WriteByte(plantumlAlphabet[((b2&0xF)<<2)|(b3>>6)])
		sb.WriteByte(plantumlAlphabet[b3&0x3F])
	}
	return sb.String()
}
