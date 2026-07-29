package processors

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/url"
	"sieve/sieve/block"
	"testing"
)

// A stored smart-image src is a bare asset filename. MarkdownRepresentation must emit a
// WORKING served URL (/sieve/<uuid>/<filename>) — not the bare filename — because the
// embedded markdown renders as a plain <img> with no NodeView resolveSrc to fix it.
// (Regression: embedding a smart-image produced ![](im-82d3.png), which 404s.)
func TestSmartImageProcessor_MarkdownRepresentation_servedURL(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"src": "im-82d3.png", "alt": "a sprite"}}

	got := p.MarkdownRepresentation(blk, "doc-uuid-1")
	want := "![a sprite](/sieve/doc-uuid-1/im-82d3.png)"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q (must carry the served /sieve/<uuid>/ URL)", got, want)
	}
}

func TestSmartImageProcessor_MarkdownRepresentation_stripsAssetsPrefixAndPath(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"src": ".assets/im-9.png"}}

	if got := p.MarkdownRepresentation(blk, "u1"); got != "![](/sieve/u1/im-9.png)" {
		t.Errorf("got %q, want the basename under /sieve/u1/", got)
	}
}

func TestSmartImageProcessor_MarkdownRepresentation_emptySrc(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	if got := p.MarkdownRepresentation(block.SieveBlock{Attrs: map[string]interface{}{}}, "u1"); got != "" {
		t.Errorf("empty src must yield empty markdown, got %q", got)
	}
}

// A plantuml diagram entry only has something to extract once it has actually
// been rendered — the frontend's acquisition path (renderDiagramSvgEntry) fetches
// the persisted svgAsset; a never-rendered block has no SVG to fetch.
func TestSmartImageProcessor_IsSupportedContent_plantumlWithSvgAssetOffersSieveActions(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	attrs := map[string]interface{}{
		"diagramType": "plantuml",
		"source":      "A -> B",
		"svgAsset":    "di-1.svg",
	}
	raw, err := json.Marshal(attrs)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/diagram", Content: string(raw)}}

	got := p.IsSupportedContent(entries)
	if !got.Has(block.ActionExtract) {
		t.Error("plantuml diagram with a non-empty svgAsset must offer extract-to-image")
	}
}

func TestSmartImageProcessor_IsSupportedContent_plantumlWithoutSvgAssetNotOffered(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	attrs := map[string]interface{}{
		"diagramType": "plantuml",
		"source":      "A -> B",
		"svgAsset":    "",
	}
	raw, err := json.Marshal(attrs)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/diagram", Content: string(raw)}}

	got := p.IsSupportedContent(entries)
	if got.Has(block.ActionExtract) {
		t.Error("plantuml diagram with no rendered svgAsset must not offer extract-to-image — there is nothing to extract yet")
	}
}

// The raw ```plantuml fence path stays mermaid-only: there is no client-side
// plantuml renderer able to resolve a bare fence into an image (unlike mermaid,
// which SmartImageRenderer's resolveEntries renders locally).
func TestSmartImageProcessor_IsSupportedContent_plantumlFenceNotOffered(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	content := "```plantuml\n@startuml\nA -> B\n@enduml\n```"
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: content}}

	got := p.IsSupportedContent(entries)
	if got.Has(block.ActionPaste) || got.Has(block.ActionTransform) {
		t.Error("a raw plantuml fence must not be offered as smart-image content")
	}
}

// --- measure: the ONE sizing rule every ingest path shares (#53) -------------
//
// #53 was caused by each Transform branch inventing its own attrs, so only raw
// SVG carried a dimension and paste/convert landed unsized — and an SVG with no
// size lays out at ZERO, showing just the resize handle. These pin the single
// rule that replaced them: report the image's OWN size, never a layout choice.

// A 2x3 PNG, base64 of the smallest valid encoder output.
func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode test png: %v", err)
	}
	return buf.Bytes()
}

func TestSmartImageProcessor_measure_rasterUsesDecodedBounds(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})

	w, h, ok := p.measure(testPNG(t, 640, 480))
	if !ok || w != 640 || h != 480 {
		t.Errorf("measure(png 640x480) = (%d, %d, %v), want (640, 480, true)", w, h, ok)
	}
}

// Oversized input is stored at its TRUE size. Clamping to the pane is the
// renderer's job (max-width:100%), so no cap is baked into the document — a
// stored number is frozen, a responsive one re-adapts on every window resize.
func TestSmartImageProcessor_measure_oversizedIsNotCapped(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})

	w, h, ok := p.measure(testPNG(t, 3000, 2000))
	if !ok || w != 3000 || h != 2000 {
		t.Errorf("measure(png 3000x2000) = (%d, %d, %v), want the true size (3000, 2000, true) — layout is the renderer's job", w, h, ok)
	}
}

func TestSmartImageProcessor_measure_svgExplicitWidthHeight(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect/></svg>`)

	if w, h, ok := p.measure(svg); !ok || w != 320 || h != 240 {
		t.Errorf("measure(svg width/height) = (%d, %d, %v), want (320, 240, true)", w, h, ok)
	}
}

func TestSmartImageProcessor_measure_svgPxSuffixAndXMLProlog(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := []byte(`<?xml version="1.0"?>` + "\n" + `<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px"/>`)

	if w, h, ok := p.measure(svg); !ok || w != 100 || h != 50 {
		t.Errorf("measure(svg behind an XML prolog, px units) = (%d, %d, %v), want (100, 50, true)", w, h, ok)
	}
}

// The mermaid shape: no absolute size, only a viewBox. This is the diagram
// Extract→Image path, one of the two #53 reproductions.
func TestSmartImageProcessor_measure_svgViewBoxOnly(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 768"><g/></svg>`)

	if w, h, ok := p.measure(svg); !ok || w != 1024 || h != 768 {
		t.Errorf("measure(svg viewBox only) = (%d, %d, %v), want the viewBox extent (1024, 768, true)", w, h, ok)
	}
}

// A relative width is NOT a pixel size, so it must fall through to the viewBox
// rather than being read as "50 pixels".
func TestSmartImageProcessor_measure_svgPercentWidthFallsBackToViewBox(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="50%" viewBox="0 0 800 600"/>`)

	if w, h, ok := p.measure(svg); !ok || w != 800 || h != 600 {
		t.Errorf("measure(svg with %% width) = (%d, %d, %v), want the viewBox extent (800, 600, true)", w, h, ok)
	}
}

// An SVG declaring neither a size nor a viewBox is ACCEPTED and stored UNSIZED.
// Deliberate: no default is invented here. The renderer fills the available
// width instead, which needs no magic number and re-adapts on resize.
func TestSmartImageProcessor_measure_svgWithNoDeclaredSizeIsAcceptedUnsized(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>`)

	w, h, ok := p.measure(svg)
	if !ok {
		t.Fatal("measure(sizeless svg): ok = false, want true — it is still a storable image")
	}
	if w != 0 || h != 0 {
		t.Errorf("measure(sizeless svg) = (%d, %d), want (0, 0) — sizing is the renderer's job, no default may be frozen into the document", w, h)
	}
}

// The validity gate: ok=false is the ONLY signal that ingest must abort.
func TestSmartImageProcessor_measure_rejectsNonImageBytes(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})

	if w, h, ok := p.measure([]byte("this is not an image at all")); ok {
		t.Errorf("measure(garbage) = (%d, %d, %v), want ok=false", w, h, ok)
	}
}

func TestSmartImageProcessor_decodeDataURI_base64AndPercentEncoded(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`

	b64 := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
	if got, err := p.decodeDataURI(b64); err != nil || string(got) != svg {
		t.Errorf("decodeDataURI(base64) = (%q, %v), want the svg source", got, err)
	}

	pct := "data:image/svg+xml," + url.PathEscape(svg)
	if got, err := p.decodeDataURI(pct); err != nil || string(got) != svg {
		t.Errorf("decodeDataURI(percent-encoded) = (%q, %v), want the svg source", got, err)
	}
}

// A pasted SVG data URI is the OTHER #53 reproduction: it used to match the
// base64 branch and return {src} alone, so it landed with no size at all. It
// must now be measured by exactly the same rule as any other source.
func TestSmartImageProcessor_pastedSvgDataURIIsMeasured(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"/>`
	dataURI := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))

	raw, err := p.decodeDataURI(dataURI)
	if err != nil {
		t.Fatalf("decodeDataURI: %v", err)
	}
	if w, h, ok := p.measure(raw); !ok || w != 400 || h != 300 {
		t.Errorf("pasted SVG data URI measured (%d, %d, %v), want (400, 300, true) — the paste path used to stamp nothing (#53)", w, h, ok)
	}
}
