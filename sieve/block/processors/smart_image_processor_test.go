package processors

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

const (
	imageDocUUID   = "0197b1f4-5a5a-7000-8000-00000000a001"
	imageOtherUUID = "0197b1f4-5a5a-7000-8000-00000000a002"
)

// MarkdownRepresentation must emit a WORKING served URL (/ui/assets/<uuid>/<key>)
// for whatever spelling the stored src takes, because the embedded markdown
// renders as a plain <img> with no NodeView resolveSrc to fix it. A src that names
// no asset has no route, and yields no image at all.
func TestSmartImageProcessor_MarkdownRepresentation(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	cases := []struct {
		name  string
		attrs map[string]interface{}
		want  string
	}{
		{"own sieve address", map[string]interface{}{"src": "sieve://" + imageDocUUID + "/im-82d3.png", "alt": "a sprite"}, "![a sprite](/ui/assets/" + imageDocUUID + "/im-82d3.png)"},
		{"legacy relative reference", map[string]interface{}{"src": "/im-82d3.png", "alt": "a sprite"}, "![a sprite](/ui/assets/" + imageDocUUID + "/im-82d3.png)"},
		{"cross-container sieve address", map[string]interface{}{"src": "sieve://" + imageOtherUUID + "/remote.png", "alt": "shared"}, "![shared](/ui/assets/" + imageOtherUUID + "/remote.png)"},
		{"legacy bare filename", map[string]interface{}{"src": "im-82d3.png", "alt": "a sprite"}, "![a sprite](/ui/assets/" + imageDocUUID + "/im-82d3.png)"},
		{"legacy .assets/ filename", map[string]interface{}{"src": ".assets/im-9.png"}, "![](/ui/assets/" + imageDocUUID + "/im-9.png)"},
		{"summary stands in for a missing alt", map[string]interface{}{"src": "sieve://" + imageDocUUID + "/im-9.png", "summary": "a chart"}, "![a chart](/ui/assets/" + imageDocUUID + "/im-9.png)"},
		{"a src naming no asset embeds nothing", map[string]interface{}{"src": ".assets/sub/im-9.png"}, ""},
		{"empty src", map[string]interface{}{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := p.MarkdownRepresentation(block.SieveBlock{Attrs: tc.attrs}, imageDocUUID); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// BuildContext names the image by its asset key, decoded, whatever spelling the
// src takes.
func TestSmartImageProcessor_BuildContext_namesTheKey(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	for _, src := range []string{
		"sieve://" + imageDocUUID + "/%E6%97%A5%E6%9C%AC.png",
		"/日本.png",
		"/ui/assets/" + imageDocUUID + "/日本.png",
	} {
		ctx := p.BuildContext(block.SieveBlock{ID: "im-1", Attrs: map[string]interface{}{"src": src}}, block.DocView{}, nil)
		if ctx.Content != "Image: 日本.png\n" {
			t.Errorf("BuildContext(%q).Content = %q, want the decoded key", src, ctx.Content)
		}
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

// imageFixture is a smart-image processor over a real store holding two
// documents: source, which owns one PNG asset minted as chart.png (sourceKey),
// and target, which owns nothing.
type imageFixture struct {
	p              *SmartImageProcessor
	assets         *services.AssetService
	source, target string
	sourceKey      string
	png            []byte
}

func newImageFixture(t *testing.T) imageFixture {
	t.Helper()
	ds, fs := newTestDocumentService(t)
	assets := services.NewAssetService(fs, "")
	svc := block.BlockServices{Documents: ds, Assets: assets}
	f := imageFixture{p: NewSmartImageProcessor(svc), assets: assets, png: testPNG(t, 4, 3)}
	for _, uuid := range []*string{&f.source, &f.target} {
		doc, err := ds.New()
		if err != nil {
			t.Fatalf("new document: %v", err)
		}
		*uuid = doc.UUID()
	}
	ref, err := f.p.assets.mint(f.source, "chart.png", f.png)
	if err != nil {
		t.Fatalf("seed source asset: %v", err)
	}
	f.sourceKey = f.p.assets.filename(ref)
	return f
}

// heldCopy asserts ref is the absolute address of an asset of the target holding
// the source's bytes, that the source's asset is untouched, and returns the key.
func (f imageFixture) heldCopy(t *testing.T, ref string) string {
	t.Helper()
	addr, err := domain.ParseAddress(ref)
	if err != nil || addr.Container != f.target || addr.Leaf == "" {
		t.Fatalf("ref = %q, want the absolute address of an asset of the target (%v)", ref, err)
	}
	key := addr.Leaf
	got, err := f.assets.ServeAssetData(f.target, key)
	if err != nil || !bytes.Equal(got, f.png) {
		t.Fatalf("target asset %q = %d bytes, %v; want the source's bytes", key, len(got), err)
	}
	if src, err := f.assets.ServeAssetData(f.source, f.sourceKey); err != nil || !bytes.Equal(src, f.png) {
		t.Errorf("source asset changed: %d bytes, %v", len(src), err)
	}
	return key
}

// acquire's stored-asset branch takes every spelling of an asset Sieve holds. An
// asset of the target document stays a pure reference, in its absolute form; one held by another
// document is copied in, so a smart-image src never names a foreign asset.
func TestSmartImageProcessor_acquire_storedAsset(t *testing.T) {
	f := newImageFixture(t)
	img := func(src string) block.ContentEntry {
		return block.ContentEntry{MIMEType: "text/html", Content: `<img src="` + src + `">`}
	}
	own := "sieve://" + f.target + "/"
	cases := []struct {
		name    string
		entry   func(f imageFixture) block.ContentEntry
		wantRef string // "" = the source asset's bytes, to be saved by the caller
	}{
		{"relative reference", func(f imageFixture) block.ContentEntry { return block.ContentEntry{Content: "/shot.png"} }, own + "shot.png"},
		{"own served route", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "/ui/assets/" + f.target + "/im-1.png"}
		}, own + "im-1.png"},
		{"own legacy route", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "/sieve/" + f.target + "/im-1.png"}
		}, own + "im-1.png"},
		{"own route under the desktop origin", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "wails://wails/ui/assets/" + f.target + "/im-1.png"}
		}, own + "im-1.png"},
		{"own sieve URI", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "sieve://" + f.target + "/shot.png"}
		}, own + "shot.png"},
		{"own route in an html <img>", func(f imageFixture) block.ContentEntry { return img("/ui/assets/" + f.target + "/im-1.png") }, own + "im-1.png"},
		{"foreign served route", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "/ui/assets/" + f.source + "/" + f.sourceKey}
		}, ""},
		{"foreign sieve URI", func(f imageFixture) block.ContentEntry {
			return block.ContentEntry{Content: "sieve://" + f.source + "/" + f.sourceKey}
		}, ""},
		{"foreign route in an html <img>", func(f imageFixture) block.ContentEntry { return img("/ui/assets/" + f.source + "/" + f.sourceKey) }, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, ref, err := f.p.acquire(tc.entry(f), f.target, "blk-1")
			if err != nil {
				t.Fatalf("acquire: %v", err)
			}
			if tc.wantRef == "" {
				if ref != "" || !bytes.Equal(data, f.png) {
					t.Fatalf("foreign asset: ref = %q, %d bytes; want the source's bytes and no ref", ref, len(data))
				}
				return
			}
			if data != nil {
				t.Fatalf("an asset this document holds must not come back as bytes to ingest (%d bytes)", len(data))
			}
			if ref != tc.wantRef {
				t.Errorf("ref = %q, want %q", ref, tc.wantRef)
			}
		})
	}
}

// A foreign asset pasted by reference lands as a held, measured copy. Its key is the
// source asset's basename.
func TestSmartImageProcessor_Transform_foreignAssetLandsSized(t *testing.T) {
	f := newImageFixture(t)
	attrs := f.p.Transform([]block.ContentEntry{{Content: "sieve://" + f.source + "/" + f.sourceKey}}, f.target, ident.New(), block.ActionPaste)
	if attrs == nil {
		t.Fatal("Transform declined a foreign asset reference")
	}
	src, _ := attrs["src"].(string)
	if key := f.heldCopy(t, src); key != f.sourceKey {
		t.Errorf("key = %q, want the source's basename %q", key, f.sourceKey)
	}
	if attrs["width"] != "4" || attrs["height"] != "3" {
		t.Errorf("size = %vx%v, want 4x3", attrs["width"], attrs["height"])
	}
}

// Every ingested image is keyed by a readable name, in order of preference: the
// filename it arrived under, the basename of the URL it came from, then "image".
// Repeats in one document are uniquified. Only a filename becomes the title.
func TestSmartImageProcessor_Transform_ingestedImageKeyIsReadable(t *testing.T) {
	f := newImageFixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(f.png) }))
	defer srv.Close()
	own := "sieve://" + f.target + "/"
	dataURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(f.png)
	cases := []struct {
		name      string
		entry     block.ContentEntry
		wantSrc   string
		wantTitle string
	}{
		{"dropped file keeps its filename", dropped("image/png", "holiday.png", string(f.png)), own + "holiday.png", "holiday.png"},
		{"same filename is uniquified", dropped("image/png", "holiday.png", string(f.png)), own + "holiday-2.png", "holiday.png"},
		{"nameless bitmap", block.ContentEntry{MIMEType: "image/png", Content: dataURI}, own + "image.png", ""},
		{"second nameless bitmap", block.ContentEntry{MIMEType: "image/png", Content: dataURI}, own + "image-2.png", ""},
		{"pasted URL, query dropped", block.ContentEntry{MIMEType: "text/plain", Content: srv.URL + "/a/sunset.png?w=640"}, own + "sunset.png", ""},
		{"html <img>", block.ContentEntry{MIMEType: "text/html", Content: `<img src="` + srv.URL + `/photo.png">`}, own + "photo.png", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			attrs := f.p.Transform([]block.ContentEntry{tc.entry}, f.target, ident.New(), block.ActionPaste)
			if attrs == nil {
				t.Fatal("Transform declined the image")
			}
			title, _ := attrs["title"].(string)
			if attrs["src"] != tc.wantSrc || title != tc.wantTitle {
				t.Errorf("src = %v, title = %q; want %s, %q", attrs["src"], title, tc.wantSrc, tc.wantTitle)
			}
		})
	}
}

// preferredName falls back to "image" when the URL's last segment has no
// extension a key could keep.
func TestSmartImageProcessor_preferredName_urlWithoutExtension(t *testing.T) {
	f := newImageFixture(t)
	for _, content := range []string{"https://example.com/download", "https://example.com/a/b.png/"} {
		e := block.ContentEntry{MIMEType: "text/html", Content: `<img src="` + content + `">`}
		if got := f.p.preferredName(e); got != "image" {
			t.Errorf("preferredName(%q) = %q, want image", content, got)
		}
	}
}

// A foreign asset that cannot be read fails the ingest; it is never downloaded
// and never stored as a pointer at the other document.
func TestSmartImageProcessor_acquire_unreadableForeignAssetFails(t *testing.T) {
	f := newImageFixture(t)
	_, ref, err := f.p.acquire(block.ContentEntry{Content: "sieve://" + f.source + "/missing.png"}, f.target, "blk-1")
	if err == nil {
		t.Fatalf("acquire succeeded with ref %q, want an error", ref)
	}
}

// A copied smart-image arrives as its uri-list AND its sieve/smart-image view.
// The sieve view wins, so a container-less src is resolved against the document
// it was copied FROM, and the paste holds its own copy of the bytes, keyed by the
// source's title.
func TestSmartImageProcessor_Transform_copiedBlock(t *testing.T) {
	f := newImageFixture(t)
	view := func(container string, src string) []block.ContentEntry {
		attrs, _ := json.Marshal(map[string]interface{}{
			"kind": "smart-image", "id": "src-block", "src": src, "width": "4", "height": "3",
			"title": "chart.png", "alt": "a chart", "summary": "Q3", "detect": "chart", "showSummary": true, "status": "COMPLETE",
		})
		sieve := block.ContentEntry{MIMEType: "sieve/smart-image", Content: string(attrs)}
		if container != "" {
			sieve.Context = map[string]interface{}{"container": container}
		}
		return []block.ContentEntry{{MIMEType: "text/uri-list", Content: src}, sieve}
	}

	sourceSrc := "sieve://" + f.source + "/" + f.sourceKey
	t.Run("across documents", func(t *testing.T) {
		attrs := f.p.Transform(view(f.source, sourceSrc), f.target, ident.New(), block.ActionPaste)
		if attrs == nil {
			t.Fatal("Transform declined a copied smart-image")
		}
		src, _ := attrs["src"].(string)
		if key := f.heldCopy(t, src); key != "chart.png" {
			t.Errorf("key = %q, want the source's title chart.png", key)
		}
		for k, want := range map[string]interface{}{"width": "4", "height": "3", "title": "chart.png", "alt": "a chart", "summary": "Q3", "detect": "chart", "showSummary": true} {
			if attrs[k] != want {
				t.Errorf("%s = %v, want %v carried over", k, attrs[k], want)
			}
		}
		if _, carried := attrs["status"]; carried {
			t.Error("status describes the source block's lifecycle and must not be carried over")
		}
	})

	t.Run("a described source is born complete, an undescribed one pending", func(t *testing.T) {
		described := f.p.InitAttrs("b1", f.p.Transform(view(f.source, sourceSrc), f.target, ident.New(), block.ActionPaste))
		if described["status"] != block.BlockStatusComplete || described["summary"] != "Q3" {
			t.Errorf("described copy: status = %v, summary = %v; want COMPLETE with the summary", described["status"], described["summary"])
		}
		undescribed := f.p.InitAttrs("b2", map[string]interface{}{"src": sourceSrc})
		if undescribed["status"] != block.BlockStatusPending {
			t.Errorf("undescribed src: status = %v, want PENDING", undescribed["status"])
		}
	})

	t.Run("within one document, a second asset", func(t *testing.T) {
		attrs := f.p.Transform(view("", sourceSrc), f.source, ident.New(), block.ActionPaste)
		src, _ := attrs["src"].(string)
		key := "chart-2.png"
		if want := "sieve://" + f.source + "/" + key; src != want {
			t.Fatalf("src = %q, want %q beside %q", src, want, f.sourceKey)
		}
		if got, err := f.assets.ServeAssetData(f.source, key); err != nil || !bytes.Equal(got, f.png) {
			t.Errorf("copy %q = %d bytes, %v; want the source's bytes", key, len(got), err)
		}
	})

	t.Run("an untitled source is keyed by its own key", func(t *testing.T) {
		entries := view(f.source, sourceSrc)
		entries[1].Content = strings.Replace(entries[1].Content, `"title":"chart.png"`, `"title":""`, 1)
		attrs := f.p.Transform(entries, f.target, ident.New(), block.ActionPaste)
		if attrs == nil || !strings.HasPrefix(attrs["src"].(string), "sieve://"+f.target+"/chart") {
			t.Errorf("Transform = %v, want a src keyed chart…, not a uuid", attrs)
		}
	})

	t.Run("a legacy relative src resolves against the source document", func(t *testing.T) {
		attrs := f.p.Transform(view(f.source, "/"+f.sourceKey), f.target, ident.New(), block.ActionPaste)
		src, _ := attrs["src"].(string)
		if key := f.heldCopy(t, src); !strings.HasPrefix(key, "chart") {
			t.Errorf("key = %q, want a copy keyed from the source's title", key)
		}
	})

	t.Run("unreadable source bytes create no block", func(t *testing.T) {
		if attrs := f.p.Transform(view(f.source, "sieve://"+f.source+"/missing.png"), f.target, ident.New(), block.ActionPaste); attrs != nil {
			t.Errorf("Transform = %v, want nil — a block must never point at the source", attrs)
		}
	})
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

// A pasted SVG data URI is the OTHER #53 reproduction: it used to match the
// base64 branch and return {src} alone, so it landed with no size at all. It
// must now be measured by exactly the same rule as any other source.
func TestSmartImageProcessor_pastedSvgDataURIIsMeasured(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"/>`
	dataURI := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))

	raw, err := block.ContentEntry{Content: dataURI}.DecodeDataURI()
	if err != nil {
		t.Fatalf("DecodeDataURI: %v", err)
	}
	if w, h, ok := p.measure(raw); !ok || w != 400 || h != 300 {
		t.Errorf("pasted SVG data URI measured (%d, %d, %v), want (400, 300, true) — the paste path used to stamp nothing (#53)", w, h, ok)
	}
}

// showSummary is a persisted RENDERING attribute (#73): the AI description is
// useful for some images and noise for most, so the choice is per-block and
// remembered — but it must never default to on, or every image in a document
// sprouts auto-generated text nobody asked for.
func TestSmartImageProcessor_InitAttrs_showSummaryDefaultsOff(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})

	attrs := p.InitAttrs("im-1", nil)
	got, present := attrs["showSummary"]
	if !present {
		t.Fatal("InitAttrs: showSummary missing — it must be a real persisted attribute, not an absent key")
	}
	if got != false {
		t.Errorf("InitAttrs: showSummary = %v, want false (never show generated text unasked)", got)
	}
}

func TestSmartImageProcessor_InitAttrs_showSummaryOverrideSurvives(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})

	attrs := p.InitAttrs("im-1", map[string]interface{}{"showSummary": true})
	if attrs["showSummary"] != true {
		t.Errorf("InitAttrs: showSummary = %v with override true, want true (the user's choice must persist)", attrs["showSummary"])
	}
}
