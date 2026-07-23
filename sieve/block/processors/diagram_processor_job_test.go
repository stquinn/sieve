package processors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// ── Fakes ───────────────────────────────────────────────────────────────────

type fakeState struct {
	settings domain.Settings
	theme    domain.ThemeVars
}

func (f fakeState) LoadSettings() domain.Settings     { return f.settings }
func (f fakeState) ActiveThemeVars() domain.ThemeVars { return f.theme }

type fakePlantuml struct {
	svg        []byte
	err        error
	calls      int
	lastSource string
}

func (f *fakePlantuml) Render(source string) ([]byte, error) {
	f.calls++
	f.lastSource = source
	if f.err != nil {
		return nil, f.err
	}
	return f.svg, nil
}

// recordingAssets records Save calls so a test can prove the asset write happens
// (in Work) before the COMPLETE flip (in Apply). Returns a stub asset whose
// ExternalRef is the derived svg filename.
type recordingAssets struct {
	saves    int
	lastData []byte
}

func (r *recordingAssets) Save(_ store.Category, _, assetID string, data []byte) (*domain.ImageAsset, error) {
	r.saves++
	r.lastData = data
	return &domain.ImageAsset{S: fakeAssetStorable{ref: assetID + ".svg"}}, nil
}

// fakeDocuments errors on LoadByUUID so saveAsset skips the doc-attach branch —
// the job-order test needs no real document.
type fakeDocuments struct{ saves int }

func (f *fakeDocuments) LoadByUUID(string) (domain.Document, error) {
	return nil, errors.New("no doc")
}
func (f *fakeDocuments) Save(d domain.Document) (domain.Document, error) { f.saves++; return d, nil }

type fakeAssetStorable struct{ ref string }

func (f fakeAssetStorable) Key() string                  { return f.ref }
func (f fakeAssetStorable) Category() store.Category     { return store.Category{} }
func (f fakeAssetStorable) Body() []byte                 { return nil }
func (f fakeAssetStorable) ExternalRef() string          { return f.ref }
func (f fakeAssetStorable) Versions() []store.VersionRef { return nil }
func (f fakeAssetStorable) IsModified() bool             { return false }
func (f fakeAssetStorable) Encoding() store.Encoding     { return store.Raw }
func (f fakeAssetStorable) BlkID() string                { return f.ref }

// darkState/lightState build a processor whose backend theme is dark/light.
func darkState() fakeState {
	return fakeState{settings: domain.DefaultSettings(), theme: domain.ThemeVars{"bg": "#1a1b26"}}
}
func lightState() fakeState {
	return fakeState{settings: domain.DefaultSettings(), theme: domain.ThemeVars{"bg": "#ffffff"}}
}

func plantumlBlock(source, mode, renderedHash string) *block.SieveBlock {
	return &block.SieveBlock{
		ID:   "di-0001",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"diagramType":  "plantuml",
			"source":       source,
			"mode":         mode,
			"status":       block.BlockStatusPending,
			"renderedHash": renderedHash,
		},
	}
}

func describe(p *DiagramProcessor, blk *block.SieveBlock) *block.ProcessorJob {
	return p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "u1", Block: blk})
}

// ── Theme preamble ──────────────────────────────────────────────────────────

func TestDiagramProcessor_effectiveSource_darkPreamble(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	got := p.effectiveSource("A -> B")
	want := "!theme cyborg\nskinparam backgroundColor transparent\nA -> B"
	if got != want {
		t.Errorf("dark effective source:\n got %q\nwant %q", got, want)
	}
}

func TestDiagramProcessor_effectiveSource_lightPreamble(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: lightState()})
	got := p.effectiveSource("A -> B")
	want := "skinparam backgroundColor transparent\nA -> B"
	if got != want {
		t.Errorf("light effective source:\n got %q\nwant %q", got, want)
	}
}

func TestDiagramProcessor_effectiveSource_missingBgTreatedDark(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: fakeState{theme: domain.ThemeVars{}}})
	if got := p.effectiveSource("X"); got != "!theme cyborg\nskinparam backgroundColor transparent\nX" {
		t.Errorf("missing bg must be treated as dark; got %q", got)
	}
}

func TestDiagramProcessor_hash_participatesInTheme(t *testing.T) {
	pd := NewDiagramProcessor(block.BlockServices{State: darkState()})
	pl := NewDiagramProcessor(block.BlockServices{State: lightState()})
	if pd.renderHash(pd.effectiveSource("A -> B")) == pl.renderHash(pl.effectiveSource("A -> B")) {
		t.Error("same source under different themes must hash differently (preamble is in the hash)")
	}
}

// ── Dispatch gating ─────────────────────────────────────────────────────────

func TestDiagramProcessor_DescribeJob_editModeNoDispatch(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	if job := describe(p, plantumlBlock("A -> B", "edit", "")); job != nil {
		t.Error("edit-mode source change must not dispatch a job")
	}
}

func TestDiagramProcessor_DescribeJob_renderNewSourceDispatches(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	if job := describe(p, plantumlBlock("A -> B", "render", "")); job == nil {
		t.Error("flip to render with unrendered source must dispatch a job")
	}
}

func TestDiagramProcessor_DescribeJob_hashMatchNoDispatch(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	hash := p.renderHash(p.effectiveSource("A -> B"))
	if job := describe(p, plantumlBlock("A -> B", "render", hash)); job != nil {
		t.Error("render with a matching renderedHash must not re-dispatch (cache hit)")
	}
}

func TestDiagramProcessor_DescribeJob_emptySourceNoDispatch(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	if job := describe(p, plantumlBlock("", "render", "")); job != nil {
		t.Error("empty plantuml source must not dispatch")
	}
}

func TestDiagramProcessor_DescribeJob_mermaidNeverDispatches(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: darkState()})
	blk := &block.SieveBlock{
		ID:    "di-m",
		Kind:  "diagram",
		Attrs: map[string]interface{}{"diagramType": "mermaid", "source": "graph TD\nA-->B", "mode": "render"},
	}
	if job := describe(p, blk); job != nil {
		t.Error("mermaid must never dispatch a job (renders client-side)")
	}
}

// ── Job body order ──────────────────────────────────────────────────────────

func TestDiagramProcessor_job_savesAssetBeforeComplete(t *testing.T) {
	assets := &recordingAssets{}
	pl := &fakePlantuml{svg: []byte("<svg>ok</svg>")}
	p := NewDiagramProcessor(block.BlockServices{
		State:     darkState(),
		Plantuml:  pl,
		Assets:    assets,
		Documents: &fakeDocuments{},
	})
	blk := plantumlBlock("A -> B", "render", "")
	job := describe(p, blk)
	if job == nil {
		t.Fatal("expected a render job")
	}
	if job.Category != block.CategoryDefault {
		t.Errorf("category: got %q, want %q", job.Category, block.CategoryDefault)
	}

	// Work performs the render + asset save; it must NOT flip status to COMPLETE.
	result, err := job.Work()
	if err != nil {
		t.Fatalf("Work: %v", err)
	}
	if pl.calls != 1 {
		t.Errorf("Render calls: got %d, want 1", pl.calls)
	}
	if assets.saves != 1 {
		t.Errorf("asset saves in Work: got %d, want 1", assets.saves)
	}
	if !bytes.Equal(assets.lastData, []byte("<svg>ok</svg>")) {
		t.Errorf("saved bytes mismatch: %q", assets.lastData)
	}
	if blk.Attrs["status"] == block.BlockStatusComplete {
		t.Error("Work must not set COMPLETE — the asset-before-COMPLETE order requires Apply to flip it")
	}

	// Apply flips the attrs — the asset already exists (saved in Work).
	job.Apply(result, blk)
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status after Apply: got %v, want COMPLETE", blk.Attrs["status"])
	}
	wantRef := "di-0001.svg"
	if blk.Attrs["svgAsset"] != wantRef {
		t.Errorf("svgAsset: got %v, want %q", blk.Attrs["svgAsset"], wantRef)
	}
	if blk.Attrs["renderedHash"] != p.renderHash(p.effectiveSource("A -> B")) {
		t.Errorf("renderedHash not set to the effective-source hash: got %v", blk.Attrs["renderedHash"])
	}
}

func TestDiagramProcessor_job_renderErrorNoAssetNoHash(t *testing.T) {
	assets := &recordingAssets{}
	pl := &fakePlantuml{err: errors.New("boom")}
	p := NewDiagramProcessor(block.BlockServices{
		State:     darkState(),
		Plantuml:  pl,
		Assets:    assets,
		Documents: &fakeDocuments{},
	})
	blk := plantumlBlock("A -> B", "render", "")
	job := describe(p, blk)
	if job == nil {
		t.Fatal("expected a render job")
	}
	if _, err := job.Work(); err == nil {
		t.Fatal("Work must surface the Render error")
	}
	if assets.saves != 0 {
		t.Errorf("no asset must be written on render failure; saves=%d", assets.saves)
	}
	if blk.Attrs["renderedHash"] != "" {
		t.Errorf("renderedHash must not update on failure; got %v", blk.Attrs["renderedHash"])
	}
}

// ── InitAttrs settings default + precedence ─────────────────────────────────

func TestDiagramProcessor_InitAttrs_settingsDefaultHonored(t *testing.T) {
	s := domain.DefaultSettings()
	s.Diagram.DefaultType = "plantuml"
	p := NewDiagramProcessor(block.BlockServices{State: fakeState{settings: s}})
	attrs := p.InitAttrs("di-1", nil)
	if attrs["diagramType"] != "plantuml" {
		t.Errorf("diagramType: got %v, want plantuml (settings default)", attrs["diagramType"])
	}
	// empty source → edit + COMPLETE
	if attrs["mode"] != "edit" || attrs["status"] != block.BlockStatusComplete {
		t.Errorf("empty plantuml: got mode=%v status=%v, want edit/COMPLETE", attrs["mode"], attrs["status"])
	}
}

func TestDiagramProcessor_InitAttrs_explicitOverrideWins(t *testing.T) {
	s := domain.DefaultSettings()
	s.Diagram.DefaultType = "plantuml"
	p := NewDiagramProcessor(block.BlockServices{State: fakeState{settings: s}})
	attrs := p.InitAttrs("di-1", map[string]interface{}{"diagramType": "mermaid"})
	if attrs["diagramType"] != "mermaid" {
		t.Errorf("explicit override must win over settings default; got %v", attrs["diagramType"])
	}
}

func TestDiagramProcessor_InitAttrs_plantumlWithSourcePending(t *testing.T) {
	s := domain.DefaultSettings()
	s.Diagram.DefaultType = "plantuml"
	p := NewDiagramProcessor(block.BlockServices{State: fakeState{settings: s}})
	attrs := p.InitAttrs("di-1", map[string]interface{}{"source": "A -> B"})
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("plantuml with source must start PENDING; got %v", attrs["status"])
	}
	if attrs["mode"] != "render" {
		t.Errorf("plantuml with source must be render mode; got %v", attrs["mode"])
	}
}

func TestDiagramProcessor_InitAttrs_mermaidWithSourceComplete(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{State: fakeState{settings: domain.DefaultSettings()}})
	attrs := p.InitAttrs("di-1", map[string]interface{}{"source": "graph TD\nA-->B", "diagramType": "mermaid"})
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("mermaid with source must stay COMPLETE; got %v", attrs["status"])
	}
}

// ── Detection / transform / representation for both engines ──────────────────

func TestDiagramProcessor_plantumlFenceDetectionAndTransform(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	src := "@startuml\nA -> B\n@enduml"
	content := "```plantuml\n" + src + "\n```"
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: content}}
	if !p.IsSupportedContent(entries).Has(block.ActionPaste) {
		t.Fatal("plantuml fence must offer paste")
	}
	overrides := p.Transform(entries, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return overrides for a plantuml fence")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	if overrides["diagramType"] != "plantuml" {
		t.Errorf("plantuml transform must set diagramType=plantuml; got %v", overrides["diagramType"])
	}
}

func TestDiagramProcessor_mermaidTransformSetsDiagramType(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	content := "```mermaid\ngraph TD\n  A-->B\n```"
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}, "", "", block.ActionPaste)
	if overrides["diagramType"] != "mermaid" {
		t.Errorf("mermaid transform must set diagramType=mermaid explicitly; got %v", overrides["diagramType"])
	}
}

func TestDiagramProcessor_codeBlockLanguagePaths(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	for _, lang := range []string{"mermaid", "plantuml"} {
		// A "code" sieve view: mimeType sieve/code, content = JSON of the attrs.
		entry := block.ContentEntry{
			MIMEType: "sieve/code",
			Content:  `{"language":"` + lang + `","source":"A -> B"}`,
		}
		entries := []block.ContentEntry{entry}
		if !p.IsSupportedContent(entries).Has(block.ActionTransform) {
			t.Fatalf("code[%s]: must offer transform", lang)
		}
		got := p.Transform(entries, "", "", block.ActionPaste)
		if got == nil {
			t.Fatalf("code[%s]: Transform returned nil", lang)
		}
		if got["diagramType"] != lang {
			t.Errorf("code[%s]: diagramType got %v, want %s", lang, got["diagramType"], lang)
		}
	}
}

// TestDiagramProcessor_TransformSieveCopyStripsRenderState proves the paste/
// duplicate path (e.IsSieveType) never lets a copy inherit the original
// block's render-job output. Without the strip, a pasted/duplicated plantuml
// diagram carries the ORIGINAL block's svgAsset + a matching renderedHash —
// DescribeJob's cache-hit check (prev == hash) then permanently skips
// rendering the copy, leaving it dependent on the original's asset file
// forever (dangles if the original document is trashed) and violating the
// one-asset-per-block invariant.
func TestDiagramProcessor_TransformSieveCopyStripsRenderState(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	original := map[string]interface{}{
		"id":           "di-orig",
		"diagramType":  "plantuml",
		"source":       "A -> B",
		"mode":         "render",
		"status":       block.BlockStatusComplete,
		"svgAsset":     "di-orig.svg",
		"renderedHash": "deadbeefcafe",
		"error":        "",
	}
	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/diagram", Content: string(raw)}}

	overrides := p.Transform(entries, "u1", "di-new", block.ActionTransform)
	if overrides == nil {
		t.Fatal("Transform must return overrides for a sieve/diagram copy")
	}
	for _, k := range []string{"svgAsset", "renderedHash", "status", "error"} {
		if v, present := overrides[k]; present {
			t.Errorf("copied overrides must not carry %q; got %v", k, v)
		}
	}
	if overrides["source"] != "A -> B" {
		t.Errorf("copy must keep the diagram source; got %v", overrides["source"])
	}

	// Feeding these overrides through InitAttrs must behave exactly like a
	// newborn plantuml block with a source: PENDING, so DescribeJob dispatches
	// a fresh render job that gives the copy its own asset.
	attrs := p.InitAttrs("di-new", overrides)
	if attrs["status"] != block.BlockStatusPending {
		t.Fatalf("copy must start PENDING so it renders its own asset; got %v", attrs["status"])
	}

	assets := &recordingAssets{}
	pl := &fakePlantuml{svg: []byte("<svg>ok</svg>")}
	p2 := NewDiagramProcessor(block.BlockServices{
		State:     darkState(),
		Plantuml:  pl,
		Assets:    assets,
		Documents: &fakeDocuments{},
	})
	blk := &block.SieveBlock{ID: "di-new", Kind: "diagram", Attrs: attrs}
	job := describe(p2, blk)
	if job == nil {
		t.Fatal("copy must dispatch its own render job, not reuse the original's cached hash/asset")
	}
}

func TestDiagramProcessor_MarkdownRepresentation_plantuml(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": "A -> B", "diagramType": "plantuml"}}
	if got := p.MarkdownRepresentation(blk, ""); got != "```plantuml\nA -> B\n```" {
		t.Errorf("MarkdownRepresentation plantuml: got %q", got)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_emptyTypeDefaultsMermaid(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": "graph TD\nA-->B"}}
	if got := p.MarkdownRepresentation(blk, ""); got != "```mermaid\ngraph TD\nA-->B\n```" {
		t.Errorf("empty diagramType must default to mermaid fence; got %q", got)
	}
}

func TestDiagramProcessor_BuildContext_plantumlFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{ID: "di-1", Attrs: map[string]interface{}{"source": "A -> B", "diagramType": "plantuml"}}
	if got := p.BuildContext(blk, block.DocView{}, map[string]bool{}).String(); !strings.Contains(got, "```plantuml") {
		t.Errorf("BuildContext must use the plantuml fence; got %q", got)
	}
}
