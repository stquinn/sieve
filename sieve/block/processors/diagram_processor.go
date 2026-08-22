package processors

import (
	"crypto/sha256"
	"encoding/hex"
	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"strconv"
	"strings"
	"time"
)

// mermaidFenceRe / plantumlFenceRe alias the shared patterns so this file reads
// naturally.
var (
	mermaidFenceRe  = block.MermaidFenceRe
	plantumlFenceRe = block.PlantumlFenceRe
)

// DiagramProcessor handles the 'diagram' block kind. One kind, two engines: the
// engine is the `diagramType` attr ("mermaid" | "plantuml").
//
// Mermaid renders entirely client-side (no async work, born COMPLETE). PlantUML
// has no browser renderer, so it renders via a processor job: DescribeJob fetches
// SVG from the configured PlantUML server (through PlantumlPort) and persists it as
// a document asset — the frontend stays passive, displaying job status then the
// asset, exactly like the other job-backed kinds.
type DiagramProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewDiagramProcessor(svc block.BlockServices) *DiagramProcessor {
	return &DiagramProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "diagram"}}
}

func (p *DiagramProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *DiagramProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *DiagramProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusComplete,
		"source":            "",
		"diagramType":       p.defaultDiagramType(),
		"mode":              "render",
		"svgAsset":          "",
		"renderedHash":      "",
		"error":             "",
		"supportsEmbedding": true,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
	}
	// Explicit override (paste/transform detection) wins over the settings default.
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	// Empty source → open in edit mode so the user can type immediately.
	source, _ := attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		attrs["mode"] = "edit"
	}
	// PlantUML with a non-empty source starts PENDING so the render job dispatches
	// on creation. Mermaid (and empty-source plantuml) stay COMPLETE — mermaid
	// renders client-side, empty plantuml has nothing to render yet.
	if dt, _ := attrs["diagramType"].(string); dt == "plantuml" && strings.TrimSpace(source) != "" {
		attrs["status"] = block.BlockStatusPending
	}
	return attrs
}

// defaultDiagramType is the settings-configured engine new blocks are born with,
// falling back to mermaid when settings are unavailable or unset.
func (p *DiagramProcessor) defaultDiagramType() string {
	if p.svc.State != nil {
		if dt := strings.TrimSpace(p.svc.State.LoadSettings().Diagram.DefaultType); dt != "" {
			return dt
		}
	}
	return "mermaid"
}

func (p *DiagramProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if mermaidFenceRe.MatchString(e.Content) || plantumlFenceRe.MatchString(e.Content) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			if lang, _ := attrs["language"].(string); lang == "mermaid" || lang == "plantuml" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste,
						block.ActionExtract, block.ActionTransform}}
				}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *DiagramProcessor) Transform(entries []block.ContentEntry, _ string, _ string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return p.stripRenderState(e.AsAttrsForNewBlock(p))
		}
		if m := mermaidFenceRe.FindStringSubmatch(e.Content); m != nil {
			return map[string]interface{}{"source": strings.TrimSpace(m[1]), "diagramType": "mermaid"}
		}
		if m := plantumlFenceRe.FindStringSubmatch(e.Content); m != nil {
			return map[string]interface{}{"source": strings.TrimSpace(m[1]), "diagramType": "plantuml"}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			if lang, _ := attrs["language"].(string); lang == "mermaid" || lang == "plantuml" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return map[string]interface{}{"source": src, "diagramType": lang}
				}
			}
		}
	}
	return nil
}

// stripRenderState removes the render-job's OUTPUT attrs (svgAsset,
// renderedHash, error, status) from a copied block's overrides. A pasted or
// duplicated plantuml diagram (e.IsSieveType path in Transform) otherwise
// inherits the ORIGINAL block's asset reference and a matching renderedHash —
// DescribeJob's cache-hit check would then never re-render the copy, leaving
// it permanently dependent on the original's asset file (dangling if that
// document is later trashed) and violating the one-asset-per-block invariant.
// Stripping these attrs makes InitAttrs treat the copy exactly as newborn:
// plantuml + non-empty source → PENDING → its own render job → its own asset.
// Mermaid is unaffected (it carries no render-job attrs to strip).
func (p *DiagramProcessor) stripRenderState(attrs map[string]interface{}) map[string]interface{} {
	for _, k := range []string{"svgAsset", "renderedHash", "error", "status"} {
		delete(attrs, k)
	}
	return attrs
}

// OnChange re-arms a block that just became stale outside creation — the engine
// switch mermaid→plantuml, an edit-mode source edit followed by a flip back to
// render, or a theme change invalidating the renderedHash — none of which pass
// through InitAttrs. DescribeJob only ever runs once a job is already dispatched
// (BlockStatusPending -> DISPATCHED in DispatchJobIfNeeded), so without this hook
// a post-creation transition into "needs a render" never gets the PENDING status
// that makes DispatchJobIfNeeded claim it, and the block sits COMPLETE with a
// stale asset forever. This is the ONLY place the renderedHash cache gates
// anything — see needsRender and DescribeJob's doc comments. Never clobbers a
// job already PENDING or in flight (DISPATCHED) — this only arms an idle stale
// block.
func (p *DiagramProcessor) OnChange(blk *block.SieveBlock) {
	if !p.needsRender(*blk) {
		return
	}
	switch blk.Status() {
	case block.BlockStatusPending, block.BlockStatusDispatched:
		return
	}
	blk.Attrs["status"] = block.BlockStatusPending
	blk.Attrs["createdAt"] = time.Now().UTC().Format(time.RFC3339)
	blk.Attrs["error"] = ""
}

// isRenderable is the shared eligibility predicate for a plantuml render: the
// engine is plantuml, there is a non-empty source, and the block is showing the
// render surface (not mid-edit). It says nothing about staleness — that is
// needsRender's job, layered on top for the ARMING decision only.
func (p *DiagramProcessor) isRenderable(blk block.SieveBlock) bool {
	if dt, _ := blk.Attrs["diagramType"].(string); dt != "plantuml" {
		return false // mermaid renders client-side
	}
	source, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		return false
	}
	mode, _ := blk.Attrs["mode"].(string)
	return mode == "render" // editing syncs source but must not dispatch
}

// needsRender is the ARMING predicate used exclusively by OnChange: true when a
// renderable plantuml block's effective-source hash no longer matches its last
// render. This is where the no-redundant-render guarantee lives — nothing arms
// PENDING for an unchanged hash, so DescribeJob never needs to re-check it (see
// DescribeJob's doc comment).
func (p *DiagramProcessor) needsRender(blk block.SieveBlock) bool {
	if !p.isRenderable(blk) {
		return false
	}
	source, _ := blk.Attrs["source"].(string)
	prev, _ := blk.Attrs["renderedHash"].(string)
	return prev != p.renderHash(p.effectiveSource(source))
}

func (p *DiagramProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return block.AIContext{}
	}
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: p.fence(blk, src)}
}

// DescribeJob returns a PlantUML render job, or nil. Mermaid renders client-side
// and is born COMPLETE — always nil. PlantUML dispatches whenever the block is
// renderable (mode == "render" AND non-empty source) — deliberately WITHOUT
// re-checking the renderedHash cache. DescribeJob only ever runs after an
// explicit claim (PENDING -> DISPATCHED in DispatchJobIfNeeded), and a claim is
// always intentional: either OnChange armed a genuinely stale block, or the user
// hit replay, which means "re-render regardless of the cache". The
// no-redundant-render guarantee lives entirely in OnChange (nothing arms PENDING
// when the hash already matches) — if DescribeJob repeated that check here, a
// claimed hash-matching block (the replay case) would return nil and RunJob's
// nil-job early-return would leave the block wedged in DISPATCHED forever, since
// nothing else settles its status.
func (p *DiagramProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	if !p.isRenderable(*blk) {
		return nil
	}

	source, _ := blk.Attrs["source"].(string)
	effective := p.effectiveSource(source)
	hash := p.renderHash(effective)

	uuid, id := jctx.UUID, blk.ID
	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    "Rendering diagram…",
		Work: func() (any, error) {
			svg, err := p.svc.Plantuml.Render(effective)
			if err != nil {
				logger.Warn("diagram: plantuml render failed", "block", id, "err", err)
				return nil, err
			}
			ref, err := p.saveAsset(uuid, id, svg)
			if err != nil {
				logger.Warn("diagram: asset save failed", "block", id, "err", err)
				return nil, err
			}
			return ref, nil
		},
		// Apply runs only after Work succeeds, so the asset provably exists before
		// COMPLETE reaches the frontend — the status attr is the synchronization,
		// the renderer never polls. The framework writes the ERROR state on failure.
		Apply: func(result any, b *block.SieveBlock) {
			b.Attrs["svgAsset"] = result.(string)
			b.Attrs["renderedHash"] = hash
			b.Attrs["status"] = block.BlockStatusComplete
		},
	}
}

// effectiveSource is the actual render input: the theme preamble, then the user
// source. Prepending gives correct precedence for free — user directives later in
// the file override ours. Because the preamble is part of this string, it is part
// of renderHash, so a theme switch makes rendered blocks honestly stale.
func (p *DiagramProcessor) effectiveSource(source string) string {
	return p.themePreamble() + "\n" + source
}

// themePreamble maps the app's active theme onto a per-variable skinparam
// block, so class/sequence/state/activity diagrams read as native to the app
// rather than in PlantUML's stock black-on-white palette. "backgroundColor
// transparent" stays a literal in both families — the SVG canvas itself has no
// backing fill either way, so there is no theme var to source it from.
//
// Fallback policy: every value below is sourced from ActiveThemeVars(); a key
// absent from the map falls back to a generic dark/light constant selected by
// isDarkTheme. Every theme this app ships populates all four source keys, so
// the fallback path is a defensive floor, not the common case — it exists so a
// malformed or partial theme file degrades to *a* legible palette instead of
// PlantUML's raw defaults.
func (p *DiagramProcessor) themePreamble() string {
	vars := p.activeThemeVars()
	dark := p.isDarkTheme(vars)

	text := p.themeVar(vars, "text", dark, "#e0e0e0", "#1a1a1a")
	mono := p.singleFontName(p.themeVar(vars, "monoFont", dark, "monospace", "monospace"))
	border := p.themeVar(vars, "border2", dark, "#555555", "#bbbbbb")
	bgAlt := p.themeVar(vars, "bgAlt", dark, "#2a2a2a", "#f2f2f2")

	lines := []string{
		"skinparam backgroundColor transparent",
		"skinparam DefaultFontColor " + text,
		"skinparam DefaultFontName " + mono,
		"skinparam ArrowColor " + border,
		"skinparam ArrowFontColor " + text,
		"skinparam ClassBackgroundColor " + bgAlt,
		"skinparam ClassBorderColor " + border,
		"skinparam ClassFontColor " + text,
		"skinparam ActivityBackgroundColor " + bgAlt,
		"skinparam ActivityBorderColor " + border,
		"skinparam ActivityDiamondBackgroundColor " + bgAlt,
		"skinparam ActivityDiamondBorderColor " + border,
		"skinparam StateBackgroundColor " + bgAlt,
		"skinparam StateBorderColor " + border,
		"skinparam ParticipantBackgroundColor " + bgAlt,
		"skinparam ParticipantBorderColor " + border,
		"skinparam ParticipantFontColor " + text,
		"skinparam ActorBackgroundColor " + bgAlt,
		"skinparam ActorBorderColor " + border,
		"skinparam ActorFontColor " + text,
		"skinparam NodeBackgroundColor " + bgAlt,
		"skinparam NodeBorderColor " + border,
		"skinparam SequenceLifeLineBorderColor " + border,
		"skinparam NoteBackgroundColor " + bgAlt,
		"skinparam NoteBorderColor " + border,
		"skinparam NoteFontColor " + text,
	}
	return strings.Join(lines, "\n")
}

// activeThemeVars fetches the current theme map, tolerating a nil State port
// (test doubles that construct DiagramProcessor without one).
func (p *DiagramProcessor) activeThemeVars() domain.ThemeVars {
	if p.svc.State == nil {
		return nil
	}
	return p.svc.State.ActiveThemeVars()
}

// isDarkTheme classifies the app theme from its background colour's relative
// luminance (threshold 0.5). A missing/unparseable bg is treated as dark — this
// app's default themes are dark. Its sole remaining job is choosing which
// generic constants themeVar falls back to when a specific key is absent.
func (p *DiagramProcessor) isDarkTheme(vars domain.ThemeVars) bool {
	lum, ok := p.relativeLuminance(vars["bg"])
	if !ok {
		return true
	}
	return lum < 0.5
}

// themeVar reads key from vars, falling back to darkFallback/lightFallback
// (selected by dark) when the key is absent or blank.
func (p *DiagramProcessor) themeVar(vars domain.ThemeVars, key string, dark bool, darkFallback, lightFallback string) string {
	if v, ok := vars[key]; ok && strings.TrimSpace(v) != "" {
		return v
	}
	if dark {
		return darkFallback
	}
	return lightFallback
}

// singleFontName reduces a CSS font-family stack (e.g. `"Cascadia Code",
// "JetBrains Mono", monospace`) to the one name PlantUML's DefaultFontName
// accepts — it has no fallback-list concept, so every entry after the first
// would otherwise render as literal, malformed skinparam text. An empty
// first entry (blank stack) falls back to "monospace".
func (p *DiagramProcessor) singleFontName(stack string) string {
	first := strings.TrimSpace(strings.SplitN(stack, ",", 2)[0])
	first = strings.Trim(first, `"'`)
	if first == "" {
		return "monospace"
	}
	return first
}

// relativeLuminance parses a #RGB or #RRGGBB hex colour and returns its
// sRGB-weighted luminance in [0,1]. ok is false when the value is absent or not a
// parseable hex colour.
func (p *DiagramProcessor) relativeLuminance(raw string) (float64, bool) {
	h := strings.TrimPrefix(strings.TrimSpace(raw), "#")
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 {
		return 0, false
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return 0, false
	}
	r := float64((v >> 16) & 0xff)
	g := float64((v >> 8) & 0xff)
	b := float64(v & 0xff)
	return (0.2126*r + 0.7152*g + 0.0722*b) / 255.0, true
}

// renderHash is the render cache key: a stable content hash of the effective
// source. Same source under the same theme → same hash → no re-render.
func (p *DiagramProcessor) renderHash(effective string) string {
	sum := sha256.Sum256([]byte(effective))
	return hex.EncodeToString(sum[:])
}

// saveAsset persists the rendered SVG as this block's single asset (stable id
// derived from the block id, overwritten each render — no GC), attaches it to the
// document, and returns its ExternalRef. Mirrors SmartImageProcessor.saveAsset.
func (p *DiagramProcessor) saveAsset(uuid, blockID string, data []byte) (string, error) {
	cat := domain.WorkingCopy
	var doc domain.Document
	if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		doc = d
		if doc.Kind() == domain.KindNote {
			cat = domain.LibraryCategory
		}
	}

	asset, err := p.svc.Assets.Save(cat, uuid, blockID, data)
	if err != nil {
		return "", err
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := p.svc.Documents.Save(doc); err != nil {
			// Non-fatal: asset is saved; attachment metadata will be missing.
			logger.Warn("diagram: doc save after attach failed", "block", blockID, "err", err)
		}
	}

	return asset.ExternalRef(), nil
}

func (p *DiagramProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	src, _ := blk.Attrs["source"].(string)
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	return p.fence(blk, src)
}

// fence wraps source in a code fence whose language follows the block's engine
// (empty diagramType → mermaid, the legacy default).
func (p *DiagramProcessor) fence(blk block.SieveBlock, src string) string {
	lang, _ := blk.Attrs["diagramType"].(string)
	if strings.TrimSpace(lang) == "" {
		lang = "mermaid"
	}
	return "```" + lang + "\n" + src + "\n```"
}

// RawContent returns the source text this block was built from (block.RawContenter).
func (p *DiagramProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}
