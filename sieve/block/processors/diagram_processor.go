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

func (p *DiagramProcessor) IDPrefix() string { return "dia" }

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
			return e.AsAttrsForNewBlock(p)
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

func (p *DiagramProcessor) OnChange(_ *block.SieveBlock) {}

func (p *DiagramProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return block.AIContext{}
	}
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: p.fence(blk, src)}
}

// DescribeJob returns a PlantUML render job, or nil. Mermaid renders client-side
// and is born COMPLETE — always nil. PlantUML dispatches only when the render
// surface is visible (mode == "render") AND there is a source AND the effective
// source (theme preamble + user source) differs from the last render's hash.
// Editing (mode "edit") syncs source but never dispatches; the flip back to render
// is the update that satisfies the condition. A flip with an unchanged source
// hits the renderedHash cache → nil → the existing asset displays instantly.
func (p *DiagramProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	if dt, _ := blk.Attrs["diagramType"].(string); dt != "plantuml" {
		return nil // mermaid renders client-side
	}
	source, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		return nil
	}
	if mode, _ := blk.Attrs["mode"].(string); mode != "render" {
		return nil // editing syncs source but must not dispatch
	}

	effective := p.effectiveSource(source)
	hash := p.renderHash(effective)
	if prev, _ := blk.Attrs["renderedHash"].(string); prev == hash {
		return nil // unchanged since last render — existing asset shows
	}

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

// themePreamble maps the app theme to a stock PlantUML preamble: a dark theme +
// transparent background for dark app themes, transparent background only for
// light ones. The floor is legibility — raw PlantUML (near-black on transparent)
// is unreadable in dark themes. Full per-var fidelity is a deferred follow-up.
func (p *DiagramProcessor) themePreamble() string {
	if p.isDarkTheme() {
		return "!theme cyborg\nskinparam backgroundColor transparent"
	}
	return "skinparam backgroundColor transparent"
}

// isDarkTheme classifies the app theme from its background colour's relative
// luminance (threshold 0.5). A missing/unparseable bg is treated as dark — this
// app's default themes are dark.
func (p *DiagramProcessor) isDarkTheme() bool {
	var vars domain.ThemeVars
	if p.svc.State != nil {
		vars = p.svc.State.ActiveThemeVars()
	}
	lum, ok := p.relativeLuminance(vars["bg"])
	if !ok {
		return true
	}
	return lum < 0.5
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
