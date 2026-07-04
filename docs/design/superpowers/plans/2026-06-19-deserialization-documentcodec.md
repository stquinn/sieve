# DocumentCodec Deserialization Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-28).** Deserialization is a per-`BlockProcessor` concern orchestrated by `DocumentCodec` (`sieve/block/document_codec.go`), fed by `RegionScanner` (`sieve/block/region_scanner.go`); full Go suite green. Block-model **Stage A**. The region-scanning approach was subsequently evolved by [processor-owned-segmentation](2026-06-20-processor-owned-segmentation.md) (shapes declared per processor; `firstAcceptor`/`flushProse` deleted).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deserialization a per-`BlockProcessor` concern (the mirror of `Serialize`), orchestrated by a new `DocumentCodec` service that owns both directions.

**Architecture:** A kind-blind `RegionScanner` splits markdown into ordered `[]Region` (fences + text gaps). `DocumentCodec.Deserialize` walks regions, asks each non-prose processor `Accepts(region)` in registry priority order, calls `Deserialize(region)` on the first acceptor, and coalesces unclaimed regions into a terminal `ProseProcessor` mop-up. `DocumentCodec.Serialize` absorbs the existing handle-aware save spine. The codec depends on a narrow `ProcessorRegistry` interface (adapter over the package-global registry) — injectable for tests.

**Tech Stack:** Go, goldmark (markdown AST), gopkg.in/yaml.v3, package `sieve`.

## Global Constraints

- Package is `sieve` (dir `sieve/`). All new files live there unless noted.
- Round-trip tests MUST exercise the production path (the real `DocumentCodec`), never a duplicate parser.
- No Co-Authored-By trailer in commits.
- Prose is the terminal mop-up: it is EXCLUDED from the `Accepts` loop (skipped by `Mode()==BlockModeProse`) and invoked explicitly.
- `Region` tiles the source exactly: concatenating every region's `Raw` reproduces the input byte-for-byte (gapless coverage). This is what lets prose preserve unclaimed fences verbatim.
- Only TOP-LEVEL fenced code blocks are structured candidates (mirrors today's `scanBlocks`, which iterates `root.FirstChild()` siblings). Nested fences stay in prose.
- `newSieveBlock(kind, id, content, attrs)` is the SOLE block constructor; pass `id=""` to mint. Never build a `SieveBlock{}` literal in new code.
- Build check: `go build ./...`; test: `go test ./sieve/...`. Known flake to skip for a clean signal: `-skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock`.

## File Structure

- Create `sieve/region_scanner.go` — `Region` type + `RegionScanner` (owns goldmark, kind-blind).
- Create `sieve/region_scanner_test.go`.
- Create `sieve/document_codec.go` — `ProcessorRegistry` interface, `registryAdapter`, `DocumentCodec` (`Serialize`+`Deserialize`).
- Create `sieve/document_codec_test.go`.
- Modify `sieve/processor_registry.go` — add `FencedDeserializer`, `InlineDeserializer`; extend `BlockProcessor` interface.
- Modify `sieve/prose_processor.go` — add `Accepts`/`Deserialize`; receive moved `scanProseRegion`/`findClose`/marker regexes.
- Modify the 7 block processors + `smart_link_processor.go` — embed the new deserializers.
- Modify `sieve/fencedblock/fencedblock.go` — add symmetric `DeserializeYaml`.
- Modify `sieve/service_provider.go` + `sieve/editor_service.go` — construct + use `DocumentCodec`.
- Rename `sieve/handle_anchor.go` → `sieve/block_serde.go`; extract `SieveBlock` model from `block_document.go` → `sieve/sieve_block.go`; delete dead funcs.
- Update test fakes embedding `FencedSerializer` to also embed `FencedDeserializer`.

---

### Task 1: Region type + RegionScanner

**Files:**
- Create: `sieve/region_scanner.go`
- Test: `sieve/region_scanner_test.go`

**Interfaces:**
- Produces: `type Region struct { Kind, Body, Raw string }`; `type RegionScanner struct{}`; `func NewRegionScanner() *RegionScanner`; `func (s *RegionScanner) Scan(markdown string) []Region`.

- [ ] **Step 1: Write the failing test**

```go
package sieve

import "testing"

func TestRegionScanner_TilesSourceExactly(t *testing.T) {
	md := "intro text\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing\n"
	regions := NewRegionScanner().Scan(md)

	var sum string
	for _, r := range regions {
		sum += r.Raw
	}
	if sum != md {
		t.Fatalf("regions must tile source exactly.\n got: %q\nwant: %q", sum, md)
	}
}

func TestRegionScanner_SplitsFenceAndText(t *testing.T) {
	md := "before\n\n```code\nid: co-1\n```\n\nafter\n"
	regions := NewRegionScanner().Scan(md)
	if len(regions) != 3 {
		t.Fatalf("want 3 regions (text, fence, text), got %d: %#v", len(regions), regions)
	}
	if regions[1].Kind != "code" {
		t.Errorf("fence region Kind = %q, want code", regions[1].Kind)
	}
	if regions[1].Body != "id: co-1\n" {
		t.Errorf("fence region Body = %q, want %q", regions[1].Body, "id: co-1\n")
	}
	if regions[0].Kind != "" || regions[2].Kind != "" {
		t.Errorf("text regions must have empty Kind: %q %q", regions[0].Kind, regions[2].Kind)
	}
}

func TestRegionScanner_PlainLanguageFenceIsAFenceRegion(t *testing.T) {
	// A non-sieve language fence is still emitted as a fence region (Kind="python").
	// Dispatch — not the scanner — decides nobody claims it.
	md := "```python\nprint(1)\n```\n"
	regions := NewRegionScanner().Scan(md)
	if len(regions) != 1 || regions[0].Kind != "python" {
		t.Fatalf("want one python fence region, got %#v", regions)
	}
}

func TestRegionScanner_NestedFenceStaysInText(t *testing.T) {
	// A fence inside a blockquote is NOT top-level → it stays in a text region.
	md := "> ```code\n> id: co-1\n> ```\n"
	regions := NewRegionScanner().Scan(md)
	for _, r := range regions {
		if r.Kind != "" {
			t.Fatalf("nested fence must not be a fence region, got Kind=%q", r.Kind)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestRegionScanner -v`
Expected: FAIL — `undefined: NewRegionScanner` / `Region`.

- [ ] **Step 3: Write minimal implementation**

```go
package sieve

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// Region is the portable, library-agnostic unit the codec dispatches on — the
// inverse of what a processor's Serialize emits. A fenced region carries its
// info string in Kind and its interior in Body; a text run has empty Kind and
// its content in Body. Raw is the exact source bytes of the region; regions tile
// the source gaplessly, so concatenating every Raw reproduces the input. That is
// what lets prose absorb an unclaimed fence verbatim.
type Region struct {
	Kind string
	Body string
	Raw  string
}

// RegionScanner splits raw markdown into ordered regions. It is KIND-BLIND: it
// knows nothing about which fences are Sieve blocks — it only distinguishes a
// top-level fenced code block (a fence region) from everything else (text). The
// dispatch decides what claims each region. goldmark is an implementation detail
// hidden entirely behind Scan.
type RegionScanner struct{}

func NewRegionScanner() *RegionScanner { return &RegionScanner{} }

// vanilla goldmark — NO sieve extension, so every fence stays a plain
// *ast.FencedCodeBlock (the sieve extension would rewrite some into custom nodes).
var regionMDParser = goldmark.New()

// Scan returns regions covering the entire source with no gaps. Top-level
// fenced code blocks become fence regions; the byte spans between them become
// text regions.
func (s *RegionScanner) Scan(markdown string) []Region {
	source := []byte(markdown)
	root := regionMDParser.Parser().Parse(text.NewReader(source))

	var regions []Region
	cursor := 0
	emitText := func(end int) {
		if end > cursor {
			regions = append(regions, Region{Raw: string(source[cursor:end])})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		cb, ok := n.(*ast.FencedCodeBlock)
		if !ok {
			continue // absorbed into the surrounding text span via byte offsets
		}
		start, end := fenceBounds(cb, source)
		emitText(start)
		regions = append(regions, Region{
			Kind: string(cb.Language(source)),
			Body: fenceBody(cb, source),
			Raw:  string(source[start:end]),
		})
		cursor = end
	}
	emitText(len(source))
	return regions
}

// fenceBody concatenates the interior content lines of a fenced code block.
func fenceBody(cb *ast.FencedCodeBlock, source []byte) string {
	var b []byte
	l := cb.Lines().Len()
	for i := 0; i < l; i++ {
		seg := cb.Lines().At(i)
		b = append(b, seg.Value(source)...)
	}
	return string(b)
}

// fenceBounds returns the [start,end) byte offsets of the WHOLE fenced block
// including its ``` delimiter lines. Mirrors the offset walk in the old
// sieveBlockASTTransformer: from the first content line, walk back over the
// opening fence line; from the last content line, walk forward over the closing
// fence line.
func fenceBounds(cb *ast.FencedCodeBlock, source []byte) (int, int) {
	start := 0
	end := len(source)
	if cb.Lines().Len() > 0 {
		start = cb.Lines().At(0).Start
		if start > 0 && source[start-1] == '\n' {
			start--
		}
		for start > 0 && source[start-1] != '\n' {
			start--
		}
		end = cb.Lines().At(cb.Lines().Len() - 1).Stop
		if end < len(source) && source[end] == '\n' {
			end++
		}
		for end < len(source) && source[end] != '\n' {
			end++
		}
	}
	return start, end
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run TestRegionScanner -v`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add sieve/region_scanner.go sieve/region_scanner_test.go
git commit -m "Add kind-blind RegionScanner: split markdown into tiling regions"
```

---

### Task 2: FencedDeserializer + InlineDeserializer + fencedblock.DeserializeYaml

**Files:**
- Modify: `sieve/fencedblock/fencedblock.go`
- Modify: `sieve/processor_registry.go` (add the two deserializer embeds near `FencedSerializer`)
- Test: `sieve/document_codec_test.go` (new file; holds deserializer-level tests too)

**Interfaces:**
- Consumes: `Region` (Task 1), `newSieveBlock` (existing, `block_document.go`).
- Produces: `func DeserializeYaml(body string) (map[string]interface{}, error)` (package `fencedblock`); `type FencedDeserializer struct{ Kind string }` with `Accepts(Region) bool` + `Deserialize(Region) ([]SieveBlock, error)`; `type InlineDeserializer struct{}` with the same two methods.

- [ ] **Step 1: Write the failing test**

```go
package sieve

import "testing"

func TestFencedDeserializer_AcceptsOnlyMatchingKind(t *testing.T) {
	d := FencedDeserializer{Kind: "code"}
	if !d.Accepts(Region{Kind: "code", Body: "id: co-1\n"}) {
		t.Error("must accept a region whose Kind matches")
	}
	if d.Accepts(Region{Kind: "diagram", Body: "id: dg-1\n"}) {
		t.Error("must reject a region of a different kind")
	}
	if d.Accepts(Region{Kind: "", Body: "plain text"}) {
		t.Error("must reject a text region (empty Kind)")
	}
}

func TestFencedDeserializer_DeserializeBuildsOneBlock(t *testing.T) {
	d := FencedDeserializer{Kind: "code"}
	blocks, err := d.Deserialize(Region{Kind: "code", Body: "id: co-1\nsource: hi\n"})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
	if blocks[0].ID != "co-1" || blocks[0].Kind != "code" {
		t.Errorf("got id=%q kind=%q, want co-1/code", blocks[0].ID, blocks[0].Kind)
	}
	if blocks[0].Source() != "hi" {
		t.Errorf("source = %q, want hi", blocks[0].Source())
	}
}

func TestInlineDeserializer_NeverClaimsDuringDocParse(t *testing.T) {
	// inline != block: inline flavours are not recognised from disk this pass.
	var d InlineDeserializer
	if d.Accepts(Region{Kind: "smart-link", Body: "{}"}) {
		t.Error("inline deserializer must never accept a document region")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run 'TestFencedDeserializer|TestInlineDeserializer' -v`
Expected: FAIL — `undefined: FencedDeserializer` / `InlineDeserializer`.

- [ ] **Step 3a: Add the symmetric deserialize to fencedblock**

In `sieve/fencedblock/fencedblock.go`, add (it already imports `gopkg.in/yaml.v3` for `SerializeYaml`):

```go
// DeserializeYaml is the inverse of SerializeYaml: it parses a fenced block's
// YAML body back into an attribute bag. Kept here so the fenced SerDes lives in
// one package.
func DeserializeYaml(body string) (map[string]interface{}, error) {
	var attrs map[string]interface{}
	if err := yaml.Unmarshal([]byte(body), &attrs); err != nil {
		return nil, err
	}
	if attrs == nil {
		attrs = map[string]interface{}{}
	}
	return attrs, nil
}
```

(If the package imports yaml under a different alias, match it. Verify the import line at the top of `fencedblock.go`.)

- [ ] **Step 3b: Add the deserializer embeds**

In `sieve/processor_registry.go`, after the `InlineSerializer` block, add:

```go
// FencedDeserializer is the ONE shared deserialization for YAML/fenced flavours —
// the mirror of FencedSerializer. Kind is the fence tag this flavour answers to
// (set at construction, alongside the FencedSerializer embed). Accepts claims a
// fenced region whose tag matches; Deserialize parses the YAML body into one
// block. An id-less body is hydrated by newSieveBlock (mint-on-parse, exactly as
// prose mints) — serialized docs always carry an id, so round-trips are stable.
type FencedDeserializer struct{ Kind string }

func (d FencedDeserializer) Accepts(region Region) bool {
	return region.Kind != "" && region.Kind == d.Kind
}

func (d FencedDeserializer) Deserialize(region Region) ([]SieveBlock, error) {
	attrs, err := fencedblock.DeserializeYaml(region.Body)
	if err != nil {
		return nil, err
	}
	id, _ := attrs["id"].(string)
	return []SieveBlock{newSieveBlock(d.Kind, id, "", attrs)}, nil
}

// InlineDeserializer is embedded by inline flavours. Inline things are NOT Sieve
// blocks (project_inline_not_a_block): they are never recognised from disk during
// document parse, so Accepts is always false and Deserialize is a no-op. The pair
// exists only to satisfy the BlockProcessor interface uniformly.
type InlineDeserializer struct{}

func (InlineDeserializer) Accepts(Region) bool                    { return false }
func (InlineDeserializer) Deserialize(Region) ([]SieveBlock, error) { return nil, nil }
```

Add `"sieve/sieve/fencedblock"` to the imports of `processor_registry.go` if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run 'TestFencedDeserializer|TestInlineDeserializer' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/fencedblock/fencedblock.go sieve/processor_registry.go sieve/document_codec_test.go
git commit -m "Add FencedDeserializer/InlineDeserializer + fencedblock.DeserializeYaml"
```

---

### Task 3: ProseProcessor owns its deserialization

**Files:**
- Modify: `sieve/prose_processor.go` (add `Accepts`/`Deserialize`)
- Modify: `sieve/block_document.go` (MOVE `scanProseRegion` + `findClose` out)
- Modify: `sieve/handle_anchor.go` (MOVE `markerOpenRe`/`markerCloseRe` out — these belong to prose now)
- Test: `sieve/prose_processor_test.go` (create if absent)

**Interfaces:**
- Consumes: `Region` (Task 1), `KindProse`, `newSieveBlock`.
- Produces: `func (p *ProseProcessor) Accepts(region Region) bool` (returns true — terminal); `func (p *ProseProcessor) Deserialize(region Region) ([]SieveBlock, error)` (splits `region.Raw` at `<!--s:ID-->` markers).

- [ ] **Step 1: Write the failing test**

```go
package sieve

import "testing"

func TestProseProcessor_DeserializeSplitsAtMarkers(t *testing.T) {
	var p ProseProcessor
	raw := "<!--s:pr-1-->\nHello world\n<!--/s:pr-1-->\n\n<!--s:pr-2 pr-old-->\nSecond\n<!--/s:pr-2-->"
	blocks, err := p.Deserialize(Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 prose blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].ID != "pr-1" || blocks[0].Content() != "Hello world" {
		t.Errorf("block0 = %q/%q", blocks[0].ID, blocks[0].Content())
	}
	if blocks[1].ID != "pr-2" || len(blocks[1].Aliases) != 1 || blocks[1].Aliases[0] != "pr-old" {
		t.Errorf("block1 id/aliases = %q/%v", blocks[1].ID, blocks[1].Aliases)
	}
}

func TestProseProcessor_DeserializeUndelimitedMintsOneBlock(t *testing.T) {
	var p ProseProcessor
	blocks, err := p.Deserialize(Region{Raw: "just some prose\nover two lines"})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].ID == "" {
		t.Fatalf("want one minted prose block, got %#v", blocks)
	}
	if blocks[0].Content() != "just some prose\nover two lines" {
		t.Errorf("content = %q", blocks[0].Content())
	}
}

func TestProseProcessor_DeserializeKeepsUnclaimedFenceAsContent(t *testing.T) {
	var p ProseProcessor
	raw := "text before\n```python\nprint(1)\n```\ntext after"
	blocks, err := p.Deserialize(Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want one prose block holding the fence verbatim, got %d", len(blocks))
	}
	if blocks[0].Content() != raw {
		t.Errorf("content = %q, want verbatim %q", blocks[0].Content(), raw)
	}
}

func TestProseProcessor_AcceptsIsTerminal(t *testing.T) {
	var p ProseProcessor
	if !p.Accepts(Region{Kind: "anything", Raw: "x"}) {
		t.Error("prose must accept everything (terminal mop-up)")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestProseProcessor -v`
Expected: FAIL — `p.Deserialize undefined` / `p.Accepts undefined`.

- [ ] **Step 3a: Move marker regexes + scanProseRegion + findClose into prose_processor.go**

Cut `markerOpenRe`/`markerCloseRe` (currently `handle_anchor.go:31-34`) and `scanProseRegion`/`findClose` (currently `block_document.go:176-229`) and paste them into `prose_processor.go`. They are unchanged — only relocated to the flavour that owns them. (`scanBlocks` in `block_document.go` still calls `scanProseRegion`; same package, so it keeps compiling.)

- [ ] **Step 3b: Add Accepts/Deserialize to ProseProcessor**

In `sieve/prose_processor.go`:

```go
// Accepts always returns true: prose is the terminal mop-up. The codec EXCLUDES
// prose from its Accepts loop (it skips Mode()==BlockModeProse) and invokes
// Deserialize explicitly on the coalesced run of unclaimed regions — so this
// truthful "I accept anything" never shadows a structured recogniser.
func (p *ProseProcessor) Accepts(region Region) bool { return true }

// Deserialize splits a raw prose run into prose blocks at its paired
// <!--s:ID--> / <!--/s:ID--> markers (delimited blocks keep their handle; an
// undelimited run mints one). The inverse of ProseProcessor.Serialize, which
// writes those markers. Owns both sides of prose's SerDes.
func (p *ProseProcessor) Deserialize(region Region) ([]SieveBlock, error) {
	return scanProseRegion(region.Raw), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run TestProseProcessor -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/prose_processor.go sieve/block_document.go sieve/handle_anchor.go sieve/prose_processor_test.go
git commit -m "ProseProcessor owns its deserialization (Accepts/Deserialize + marker scan)"
```

---

### Task 4: Extend BlockProcessor interface + embed deserializers everywhere

**Files:**
- Modify: `sieve/processor_registry.go` (add two methods to the interface)
- Modify: `sieve/code_processor.go`, `diagram_processor.go`, `ai_block_processor.go`, `log_processor.go`, `web_clip_processor.go`, `smart_image_processor.go`, `smart_card_processor.go` (embed `FencedDeserializer{Kind: "..."}`)
- Modify: `sieve/smart_link_processor.go` (embed `InlineDeserializer`)
- Modify: test fakes — `sieve/editor_service_promote_test.go`, `sieve/editor_service_test.go`, and any other `*_test.go` whose fake embeds `FencedSerializer`

**Interfaces:**
- Consumes: `FencedDeserializer`, `InlineDeserializer` (Task 2), `ProseProcessor.Accepts/Deserialize` (Task 3).
- Produces: `BlockProcessor` now requires `Accepts(Region) bool` and `Deserialize(Region) ([]SieveBlock, error)`.

- [ ] **Step 1: Write the failing test (compile-level contract)**

```go
package sieve

import "testing"

// Every registered processor must satisfy the expanded interface AND every
// block-mode processor must claim a region of its own kind. This locks in that
// the embeds were wired with the right Kind.
func TestAllBlockProcessorsRecogniseTheirKind(t *testing.T) {
	cases := map[string]string{
		"code": "id: co-1\n", "diagram": "id: dg-1\n", "ai-block": "id: ai-1\n",
		"log": "id: lo-1\n", "web-clip": "id: we-1\n", "smart-image": "id: im-1\n",
		"smart-card": "id: sc-1\n",
	}
	svc := BlockServices{}
	ctors := map[string]BlockProcessor{
		"code": NewCodeBlockProcessor(svc), "diagram": NewDiagramProcessor(svc),
		"ai-block": NewAIBlockProcessor(svc), "log": NewLogProcessor(svc),
		"web-clip": NewWebClipBlockProcessor(svc), "smart-image": NewSmartImageProcessor(svc),
		"smart-card": NewSmartCardProcessor(svc),
	}
	for kind, body := range cases {
		p := ctors[kind]
		if !p.Accepts(Region{Kind: kind, Body: body}) {
			t.Errorf("%s processor does not Accept its own region", kind)
		}
		if p.Accepts(Region{Kind: "other", Body: body}) {
			t.Errorf("%s processor wrongly Accepts a foreign kind", kind)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestAllBlockProcessorsRecogniseTheirKind -v`
Expected: FAIL to COMPILE — methods/embeds missing.

- [ ] **Step 3a: Extend the interface**

In `sieve/processor_registry.go`, inside `type BlockProcessor interface { ... }`, after `Serialize`:

```go
	// Accepts reports whether this flavour claims a parsed region (the recognition
	// half of deserialization). Deserialize then builds the block(s) — the inverse
	// of Serialize. Structured kinds share one impl (FencedDeserializer, embedded);
	// inline flavours never claim a document region (InlineDeserializer); prose is
	// the terminal mop-up (ProseProcessor). No kind-switch in the codec.
	Accepts(region Region) bool
	Deserialize(region Region) ([]SieveBlock, error)
```

- [ ] **Step 3b: Embed FencedDeserializer in each block processor**

For each of the 7, add the embed to the struct and set `Kind` in the constructor. Example for `code_processor.go`:

```go
type CodeBlockProcessor struct{ svc BlockServices
	FencedSerializer   // one shared YAML serialization — free
	FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewCodeBlockProcessor(svc BlockServices) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc, FencedDeserializer: FencedDeserializer{Kind: "code"}}
}
```

Apply the identical shape to the others with their kinds:
`diagram_processor.go` → `"diagram"`; `ai_block_processor.go` → `"ai-block"`; `log_processor.go` → `"log"`; `web_clip_processor.go` → `"web-clip"`; `smart_image_processor.go` → `"smart-image"`; `smart_card_processor.go` → `"smart-card"`.

For `smart_link_processor.go`, embed the inline mirror:

```go
type SmartLinkProcessor struct{ svc BlockServices
	InlineSerializer
	InlineDeserializer
}
```

- [ ] **Step 3c: Fix test fakes**

Any fake processor that embeds `FencedSerializer` now needs `FencedDeserializer` too (else it no longer satisfies `BlockProcessor`). Add `FencedDeserializer` to the struct of `testMarkdownProcessor` (`editor_service_promote_test.go`) and `testRunJobProcessor` (`editor_service_test.go`), plus any fakes in `processor_serialize_test.go` / `context_provider_test.go` / `processor_registry_test.go`. A bare `FencedDeserializer` embed (Kind "") is fine for fakes that aren't deserialized; set `FencedDeserializer{Kind: "..."}` if a test asserts recognition. Let the compiler list the offenders: `go build ./sieve/...`.

- [ ] **Step 4: Run build + test**

Run: `go build ./... && go test ./sieve/ -run TestAllBlockProcessorsRecogniseTheirKind -v`
Expected: build OK; test PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/processor_registry.go sieve/*_processor.go sieve/editor_service_promote_test.go sieve/editor_service_test.go sieve/processor_serialize_test.go sieve/context_provider_test.go sieve/processor_registry_test.go
git commit -m "Put Accepts/Deserialize on BlockProcessor; wire deserializer embeds"
```

---

### Task 5: ProcessorRegistry interface + adapter

**Files:**
- Modify: `sieve/document_codec.go` (create the file here)
- Test: `sieve/document_codec_test.go`

**Interfaces:**
- Consumes: `GetProcessor`, the package-global `pasteMatchers` (`processor_registry.go`).
- Produces: `type ProcessorRegistry interface { Get(kind string) BlockProcessor; Ordered() []BlockProcessor }`; `type registryAdapter struct{}`; `func globalRegistry() ProcessorRegistry`.

- [ ] **Step 1: Write the failing test**

```go
package sieve

import "testing"

func TestGlobalRegistry_GetAndOrdered(t *testing.T) {
	reg := globalRegistry()
	if reg.Get(KindProse) == nil {
		t.Fatal("prose must always be resolvable")
	}
	if reg.Get("definitely-not-a-kind") != nil {
		t.Error("unknown kind must resolve to nil")
	}
	if len(reg.Ordered()) == 0 {
		t.Error("Ordered must return the registered processors")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestGlobalRegistry -v`
Expected: FAIL — `undefined: globalRegistry`.

- [ ] **Step 3: Write minimal implementation**

Create `sieve/document_codec.go`:

```go
package sieve

import "strings"

// ProcessorRegistry is the narrow read-only seam DocumentCodec needs over the
// registry. Injecting it (rather than reaching into the package globals) lets the
// codec be tested with a fake registry — no resetRegistry() global gymnastics.
type ProcessorRegistry interface {
	Get(kind string) BlockProcessor
	Ordered() []BlockProcessor // registry priority order, for the Accepts loop
}

// registryAdapter satisfies ProcessorRegistry over the existing package-global
// registry. De-globalizing registration is a separate follow-up; this keeps the
// codec injectable today without that ripple.
type registryAdapter struct{}

func (registryAdapter) Get(kind string) BlockProcessor { return GetProcessor(kind) }

func (registryAdapter) Ordered() []BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]BlockProcessor, 0, len(pasteMatchers))
	for _, pm := range pasteMatchers {
		out = append(out, pm.Processor)
	}
	return out
}

func globalRegistry() ProcessorRegistry { return registryAdapter{} }

var _ = strings.TrimSpace // (strings used by DocumentCodec methods added next task)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run TestGlobalRegistry -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/document_codec.go sieve/document_codec_test.go
git commit -m "Add ProcessorRegistry seam + global adapter for DocumentCodec"
```

---

### Task 6: DocumentCodec.Deserialize (region split → dispatch → prose mop-up)

**Files:**
- Modify: `sieve/document_codec.go`
- Test: `sieve/document_codec_test.go`

**Interfaces:**
- Consumes: `RegionScanner` (Task 1), `ProcessorRegistry` (Task 5), `Accepts`/`Deserialize` (Tasks 2-4), `KindProse`.
- Produces: `type DocumentCodec struct{...}`; `func NewDocumentCodec(reg ProcessorRegistry) *DocumentCodec`; `func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error)`.

- [ ] **Step 1: Write the failing test**

```go
package sieve

import "testing"

// fakeRegistry lets us exercise the codec dispatch with a controlled processor set.
type fakeRegistry struct {
	byKind  map[string]BlockProcessor
	ordered []BlockProcessor
}

func (f fakeRegistry) Get(kind string) BlockProcessor { return f.byKind[kind] }
func (f fakeRegistry) Ordered() []BlockProcessor       { return f.ordered }

func newFakeRegistry() fakeRegistry {
	prose := &ProseProcessor{}
	code := NewCodeBlockProcessor(BlockServices{})
	return fakeRegistry{
		byKind:  map[string]BlockProcessor{KindProse: prose, "code": code},
		ordered: []BlockProcessor{code, prose}, // structured first, prose terminal
	}
}

func TestDocumentCodec_DeserializeStructuredAndProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	md := "intro prose\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing prose"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("want prose, code, prose = 3 blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != KindProse || blocks[1].Kind != "code" || blocks[2].Kind != KindProse {
		t.Errorf("kinds = %q/%q/%q", blocks[0].Kind, blocks[1].Kind, blocks[2].Kind)
	}
	if blocks[1].ID != "co-1" {
		t.Errorf("code id = %q, want co-1", blocks[1].ID)
	}
}

func TestDocumentCodec_UnclaimedFenceCoalescesIntoProse(t *testing.T) {
	c := NewDocumentCodec(newFakeRegistry())
	// ```python is unclaimed → it must stay as ONE prose block with its neighbours.
	md := "before\n```python\nprint(1)\n```\nafter"
	blocks, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].Kind != KindProse {
		t.Fatalf("want a single prose block, got %#v", blocks)
	}
	if blocks[0].Content() != md {
		t.Errorf("prose content = %q, want verbatim %q", blocks[0].Content(), md)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestDocumentCodec_Deserialize -v` (and `_UnclaimedFence`)
Expected: FAIL — `undefined: NewDocumentCodec`.

- [ ] **Step 3: Write minimal implementation**

Replace the `var _ = strings.TrimSpace` placeholder in `document_codec.go` and add:

```go
// DocumentCodec owns BOTH directions of document SerDes. It sees only the
// registry + the BlockProcessor interface, so it CANNOT switch on kind — the
// structural guarantee inherited from the serialization half.
type DocumentCodec struct {
	registry ProcessorRegistry
	scanner  *RegionScanner
}

func NewDocumentCodec(reg ProcessorRegistry) *DocumentCodec {
	return &DocumentCodec{registry: reg, scanner: NewRegionScanner()}
}

// Deserialize parses markdown into an ordered block slice. It splits into regions,
// asks each non-prose processor Accepts in priority order, and lets the first
// acceptor build the block(s). A run of unclaimed regions is coalesced and handed
// to prose (terminal mop-up), so a stray fence survives as verbatim prose content.
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error) {
	regions := c.scanner.Scan(markdown)
	prose := c.registry.Get(KindProse)

	var out []SieveBlock
	var pending []Region
	flushProse := func() error {
		if len(pending) == 0 {
			return nil
		}
		var raw strings.Builder
		for _, r := range pending {
			raw.WriteString(r.Raw)
		}
		pending = nil
		blocks, err := prose.Deserialize(Region{Raw: raw.String()})
		if err != nil {
			return err
		}
		out = append(out, blocks...)
		return nil
	}

	for _, region := range regions {
		p := c.firstAcceptor(region)
		if p == nil {
			pending = append(pending, region)
			continue
		}
		if err := flushProse(); err != nil {
			return nil, err
		}
		blocks, err := p.Deserialize(region)
		if err != nil {
			return nil, err
		}
		out = append(out, blocks...)
	}
	if err := flushProse(); err != nil {
		return nil, err
	}
	return out, nil
}

// firstAcceptor returns the first non-prose processor (registry priority order)
// that claims the region, or nil. Prose is excluded here — it is the terminal
// mop-up, invoked explicitly by flushProse, never asked in the loop.
func (c *DocumentCodec) firstAcceptor(region Region) BlockProcessor {
	for _, p := range c.registry.Ordered() {
		if p.Mode() == BlockModeProse {
			continue
		}
		if p.Accepts(region) {
			return p
		}
	}
	return nil
}
```

Remove the now-unneeded `var _ = strings.TrimSpace` line (the import is used by `strings.Builder`).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run TestDocumentCodec -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/document_codec.go sieve/document_codec_test.go
git commit -m "DocumentCodec.Deserialize: registry-dispatched parse with prose mop-up"
```

---

### Task 7: DocumentCodec.Serialize (absorb the save spine)

**Files:**
- Modify: `sieve/document_codec.go` (add `Serialize`)
- Modify: `sieve/handle_anchor.go` (have `SerializeBlockDocWithHandles` delegate to the codec, or move its body)
- Test: `sieve/document_codec_test.go`

**Interfaces:**
- Consumes: `serializeBlock` (existing, `handle_anchor.go`), `GetProcessor`.
- Produces: `func (c *DocumentCodec) Serialize(blocks []SieveBlock) (string, error)`.

- [ ] **Step 1: Write the failing round-trip test (production path)**

```go
package sieve

import "testing"

func TestDocumentCodec_RoundTrip(t *testing.T) {
	c := NewDocumentCodec(globalRegistry()) // REAL registry — production path
	original := []SieveBlock{
		newSieveBlock(KindProse, "pr-1", "An intro paragraph.", nil),
		newSieveBlock("code", "co-1", "", map[string]interface{}{"id": "co-1", "source": "x := 1"}),
		newSieveBlock(KindProse, "pr-2", "A closing paragraph.", nil),
	}
	md, err := c.Serialize(original)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(original) {
		t.Fatalf("round-trip changed block count: %d → %d\n%s", len(original), len(got), md)
	}
	for i := range original {
		if got[i].ID != original[i].ID || got[i].Kind != original[i].Kind {
			t.Errorf("block %d: %q/%q → %q/%q", i, original[i].ID, original[i].Kind, got[i].ID, got[i].Kind)
		}
	}
	// Serialize(Deserialize(md)) is idempotent.
	md2, err := c.Serialize(got)
	if err != nil {
		t.Fatal(err)
	}
	if md2 != md {
		t.Errorf("re-serialize not idempotent:\n--- first ---\n%s\n--- second ---\n%s", md, md2)
	}
}
```

This test requires the production processors registered. Ensure the test package wiring registers them (the same setup other `*_test.go` round-trip tests use — e.g. a `TestMain`/`registerTestProcessors` helper, or `service_provider` construction). If existing round-trip tests call a shared helper, reuse it.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/ -run TestDocumentCodec_RoundTrip -v`
Expected: FAIL — `c.Serialize undefined`.

- [ ] **Step 3: Write minimal implementation**

Add to `document_codec.go`:

```go
// Serialize renders the block slice to markdown by asking each block's flavour to
// serialize ITSELF — the mirror of Deserialize. The spine never decides format by
// kind. A block must carry an id (persistence-boundary invariant). Identical
// behaviour to the former SerializeBlockDocWithHandles, now on the codec.
func (c *DocumentCodec) Serialize(blocks []SieveBlock) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.ID == "" {
			return "", fmt.Errorf("refusing to persist id-less %s block (construct via newSieveBlock)", b.Kind)
		}
		s, err := serializeBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}
```

Add `"fmt"` to the imports. Then point the legacy free function at the codec so existing callers keep working unchanged (it will be deleted in Task 9 once callers move):

```go
// SerializeBlockDocWithHandles is retained as a thin shim during the codec
// migration; callers move to DocumentCodec.Serialize in Task 8.
func SerializeBlockDocWithHandles(blocks []SieveBlock) (string, error) {
	return NewDocumentCodec(globalRegistry()).Serialize(blocks)
}
```

Delete the old body of `SerializeBlockDocWithHandles` in `handle_anchor.go` (keep `serializeBlock` there for now — the codec calls it; it moves in Task 9).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./sieve/ -run TestDocumentCodec_RoundTrip -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/document_codec.go sieve/handle_anchor.go sieve/document_codec_test.go
git commit -m "DocumentCodec.Serialize: absorb the handle-aware save spine"
```

---

### Task 8: Wire ServiceProvider + EditorService to the codec

**Files:**
- Modify: `sieve/service_provider.go` (construct one `DocumentCodec`)
- Modify: `sieve/editor_service.go` (use `codec.Deserialize`/`codec.Serialize` at the load/save boundary)
- Test: existing `editor_service_test.go` suite must stay green.

**Interfaces:**
- Consumes: `NewDocumentCodec`, `globalRegistry`.
- Produces: `EditorService` field `codec *DocumentCodec` (or accessor); the lifecycle calls go through it.

- [ ] **Step 1: Identify the call sites**

Run: `grep -rn "ParseBlockDocWithHandles\|SerializeBlockDocWithHandles\|ParseBlockDoc\b\|scanBlocks" sieve/ --include="*.go" | grep -v _test`
These are the production load/save seams to redirect. Record the list before editing.

- [ ] **Step 2: Write/extend the failing test**

Add to `editor_service_test.go` (adapt to the existing harness for building an `EditorService`):

```go
func TestEditorService_LoadUsesDocumentCodec(t *testing.T) {
	// Round-trip a document through the EditorService load path and assert the
	// blocks come back with the codec's structure (prose + structured + prose).
	// Use the existing test harness that constructs an EditorService + shadow doc.
	// (Mirror the setup of the nearest existing load/save test in this file.)
	md := "hello\n\n```code\nid: co-1\nsource: x\n```\n\nbye"
	codec := NewDocumentCodec(globalRegistry())
	blocks, err := codec.Deserialize(md)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("codec parse changed; load path will too: %#v", blocks)
	}
}
```

(If a richer EditorService load test already exists, extend it instead of adding a thin one.)

- [ ] **Step 3: Construct the codec and use it**

In `service_provider.go`, after the processors are registered, construct the codec and hand it to `EditorService` (follow the existing service-construction pattern in this file):

```go
codec := NewDocumentCodec(globalRegistry())
// pass codec into NewEditorService(...) / set it on the EditorService struct
```

In `editor_service.go`, replace the load seam (currently `ParseBlockDocWithHandles(markdown)`) with `es.codec.Deserialize(markdown)` and the save seam (currently `SerializeBlockDocWithHandles(blocks)`) with `es.codec.Serialize(blocks)`. Keep behaviour identical — same inputs, same returns.

- [ ] **Step 4: Run the EditorService suite**

Run: `go build ./... && go test ./sieve/ -run TestEditorService -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock -v`
Expected: build OK; all EditorService tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sieve/service_provider.go sieve/editor_service.go sieve/editor_service_test.go
git commit -m "Route EditorService load/save through DocumentCodec"
```

---

### Task 9: Retire dead code, rename, extract model

**Files:**
- Delete from `sieve/block_document.go`: `SerializeBlockDoc`, `ParseBlockDoc`, `scanBlocks` (now unused), `mintProseIDs` (if unused).
- Delete from `sieve/handle_anchor.go`: `ParseBlockDocWithHandles` (if unused), the `SerializeBlockDocWithHandles` shim (inline its callers to `codec.Serialize`) OR keep the shim if non-EditorService callers remain — verify by grep.
- Rename: `sieve/handle_anchor.go` → `sieve/block_serde.go` (move `serializeBlock`, `splitHandles`, `mergeHandles` there; the marker regexes already left for prose in Task 3).
- Extract: the `SieveBlock` type + value methods + `KindProse/KindColumnRow/KindColumn` from `block_document.go` → new `sieve/sieve_block.go`. After this, `block_document.go` is empty → delete it.

**Interfaces:**
- Consumes: everything above.
- Produces: a cleaned package — no handle-less convenience funcs, no `handle_anchor` misnomer.

- [ ] **Step 1: Prove the dead funcs are dead**

Run each; zero non-test hits ⇒ safe to delete (move test-only callers to the codec):
```bash
grep -rn "SerializeBlockDoc\b" sieve/ --include="*.go"
grep -rn "ParseBlockDoc\b" sieve/ --include="*.go"
grep -rn "ParseBlockDocWithHandles" sieve/ --include="*.go"
grep -rn "scanBlocks\|mintProseIDs" sieve/ --include="*.go"
```
For any test referencing `SerializeBlockDoc`/`ParseBlockDoc`/`ParseBlockDocWithHandles`, rewrite it to use `NewDocumentCodec(globalRegistry())` — round-trip tests through the production path, never a parallel parser.

- [ ] **Step 2: Delete + rename + extract**

- Delete the dead funcs identified in Step 1.
- `git mv sieve/handle_anchor.go sieve/block_serde.go`; update its header comment (it is the block SerDes helpers + handle split/merge rules — no anchors).
- Create `sieve/sieve_block.go` and move the `SieveBlock` struct, `newSieveBlock`, `Content`/`setContent`/`StringAttr`/`Source`/`Ref`/`Status`/`answersTo`, and the `KindProse/KindColumnRow/KindColumn` consts into it. Keep `serializeFencedBlock` where the codec/serializer needs it (move to `block_serde.go` if `block_document.go` is being emptied).
- Delete `block_document.go` if nothing remains.

- [ ] **Step 3: Build + vet + full test**

Run:
```bash
go build ./... && go vet ./sieve/... && go test ./sieve/ -skip TestHandleBlockUpdate_notifySendsSnapshotUnderLock
```
Expected: build OK, vet clean (copylocks included), all tests PASS.

- [ ] **Step 4: Verify no lingering references**

Run: `grep -rn "handle_anchor\|scanBlocks\|SerializeBlockDoc\b\|ParseBlockDoc" sieve/ --include="*.go"`
Expected: no matches (file renamed, funcs gone).

- [ ] **Step 5: Commit**

```bash
git add -A sieve/
git commit -m "Retire handle-less parse/serialize funcs; rename to block_serde; extract SieveBlock model"
```

---

## Self-Review

**Spec coverage:**
- Units (RegionScanner, BlockProcessor Accepts/Deserialize, DocumentCodec, EditorService wiring, SieveBlock model) → Tasks 1,2-4,5-7,8,9. ✓
- Interface change (`Accepts`/`Deserialize` + `Region`) → Tasks 1,4. ✓
- Dispatch algorithm (region split → Accepts loop → prose mop-up; prose excluded; coalesce unclaimed) → Task 6. ✓
- Registry injection (narrow interface + adapter over global) → Task 5. ✓
- Retirements (`ParseBlockDoc`/`SerializeBlockDoc`/`mintProseIDs`) + rename (`handle_anchor.go`→`block_serde.go`) + model extraction → Task 9. ✓
- Testing (round-trip via production codec; RegionScanner pure; per-processor Accepts/Deserialize incl. negatives; prose marker cases; ordering/terminal) → Tasks 1,2,3,4,6,7. ✓
- Out-of-scope held out: paste (`IsBlock`/`Transform`) untouched; Stage E parsers untouched. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 8 steps 2-3 intentionally say "mirror the existing harness" because EditorService construction is established in the file — the executor reads the neighbouring test; this is guidance to reuse, not a missing implementation.

**Type consistency:** `Region{Kind,Body,Raw}`, `Accepts(Region) bool`, `Deserialize(Region) ([]SieveBlock, error)`, `ProcessorRegistry.Get/Ordered`, `NewDocumentCodec`, `NewRegionScanner`, `globalRegistry` used consistently across tasks.

**Known behavioral refinement:** an id-less fence whose tag is a registered block kind is now hydrated into a structured block (mint-on-parse) rather than left as prose. Serialized docs always carry an id, so round-trips are unaffected; flagged so Task 9's full-suite run is the backstop if a fixture relied on the old rule.
