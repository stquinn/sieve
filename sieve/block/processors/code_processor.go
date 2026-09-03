package processors

import (
	"fmt"
	"regexp"
	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	lheur "sieve/sieve/lang"
	"strings"
	"time"
)

// codeFenceRe matches a fenced code block. The fence may be 3 or more backticks:
// the editor sizes fences longer than any backtick run in the content, so a code
// block that itself contains ``` arrives wrapped in 4+ ticks.
var codeFenceRe = regexp.MustCompile("(?s)^`{3,}(\\w*)\\n(.+)\\n`{3,}$")

const minSourceLength = 30

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewCodeBlockProcessor(svc block.BlockServices) *CodeBlockProcessor {
	return &CodeBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "code"}}
}

func (p *CodeBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
		"source":            "",
		"language":          "",
		"detectionMethod":   "",
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}

	logger.Debug("CodeBlockProcessor InitAttrs: initial attrs: %+v", attrs)
	source, _ := attrs["source"].(string)
	hint, _ := attrs["hint"].(string)
	if l, ok := lheur.DetectByHeuristics(source, hint); ok {
		attrs["language"] = l
		attrs["detectionMethod"] = "heuristic"
	}
	// Complete-vs-pending predicate MUST mirror DescribeJob: an empty-source block
	// has no async refine job, so it is born COMPLETE (never dispatched); the hint,
	// having been consumed for heuristic detection above, is dropped as the settle
	// path used to do.
	if strings.TrimSpace(source) == "" {
		attrs["status"] = block.BlockStatusComplete
		delete(attrs, "hint")
	}
	return attrs
}

func (p *CodeBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			if m[1] == "mermaid" {
				continue
			}
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
				}
			}
		}
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if _, ok := unfencedCodeContent(e); ok {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *CodeBlockProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	// A typed sieve/diagram view wins over the generic text heuristics below — a
	// diagram's raw source could otherwise be claimed as plain code, losing its
	// mermaid language. Scan for it across all entries first.
	for _, e := range entries {

		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "diagram" {
			//TODO: examine why we care if the type is mermaid - diagrams - have code... why do we care if mermaid
			if dt, _ := attrs["diagramType"].(string); dt == "mermaid" {
				if src, _ := attrs["source"].(string); strings.TrimSpace(src) != "" {
					return map[string]interface{}{
						"language":        "mermaid",
						"source":          strings.TrimSpace(src),
						"detectionMethod": "Converted from diagram block",
						"status":          block.BlockStatusComplete,
					}
				}
			}
		}
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		m := codeFenceRe.FindStringSubmatch(e.Content)
		if m != nil {
			lang := m[1]
			if lang == "mermaid" {
				continue
			}
			return map[string]interface{}{
				"language": lang,
				"source":   strings.TrimSpace(m[2]),
			}
		}

		if src, ok := unfencedCodeContent(e); ok {
			return map[string]interface{}{"source": src}
		}
	}

	return nil
}

// unfencedCodeContent returns the trimmed source of the first text entry that is
// NOT a code fence but still reads as code — either a heuristic language match or
// structural cues (braces, semicolons, indentation). This restores the smart-paste
// behaviour the pre-framework PasteMatch had: raw, unfenced source pasted into the
// editor still becomes a code block. Language is left to heuristics/AI in InitAttrs.
func unfencedCodeContent(entry block.ContentEntry) (string, bool) {

	if entry.MIMEType != "" && entry.MIMEType != "text/plain" {
		return "", false
	}
	trimmed := strings.TrimSpace(entry.Content)
	// Skip empties and anything that is itself a fence (handled / intentionally
	// skipped above, e.g. mermaid) so we never claim a fenced block as raw code.
	if trimmed == "" || codeFenceRe.MatchString(trimmed) {
		return "", false
	}
	if !strings.Contains(trimmed, "\n") {
		return "", false
	}
	if lang, ok := lheur.DetectByHeuristics(trimmed, ""); ok {
		// Markdown is a detectable "language" so that EXPLICIT markdown code
		// blocks work (a ```markdown fence, a language hint) — but on a
		// smart-paste claim a markdown detection means the text IS document
		// content. Decline it: the paste falls through to the editor's default
		// insertion, which renders pasted markdown as document markdown.
		if lang == "markdown" {
			return "", false
		}
		return trimmed, true
	}
	if lheur.LooksLikeCode(trimmed) {
		return trimmed, true
	}
	return "", false
}

func (p *CodeBlockProcessor) OnChange(blk *block.SieveBlock) {
	status, _ := blk.Attrs["status"].(string)
	if status == block.BlockStatusDispatched {
		return
	}

	source, _ := blk.Attrs["source"].(string)
	if len(strings.TrimSpace(source)) < minSourceLength {
		return
	}

	// A manual pick is the human's word, "Plain" included: nothing in the
	// detection pipeline — heuristic re-detection or the refine dispatch —
	// second-guesses it, and it needs no confidence check.
	if method, _ := blk.Attrs["detectionMethod"].(string); method == "manual" {
		return
	}

	hint, _ := blk.Attrs["hint"].(string)
	if detected, ok := lheur.DetectByHeuristics(source, hint); ok {
		curLang, _ := blk.Attrs["language"].(string)
		method, _ := blk.Attrs["detectionMethod"].(string)
		// The AI refine step is the authority that exists precisely because the
		// heuristic is unreliable (it reads a Java `package` line as Go). Once the
		// AI has settled a CONFIDENT language, never let a heuristic re-detection
		// revert it — the highlight re-render fires a spurious source update after
		// the job completes, and clobbering here would silently undo the correction.
		// A non-answer AI verdict ("text") is NOT sticky: if the user adds content
		// and the heuristic now finds a real language, we take it.
		if method == "ai" && lheur.IsConfidentLanguage(curLang) {
			return
		}
		if detected != curLang {
			blk.Attrs["language"] = detected
			blk.Attrs["detectionMethod"] = "heuristic"
		}
		return
	}

	lang, _ := blk.Attrs["language"].(string)
	if lang != "" && lang != "unknown" {
		return
	}

	if status == block.BlockStatusPending {
		return
	}

	blk.Attrs["status"] = block.BlockStatusPending
}

func (p *CodeBlockProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	language, _ := blk.Attrs["language"].(string)
	if src == "" {
		return block.AIContext{}
	}
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: "```" + language + "\n" + src + "\n```"}
	return ctx
}

func (p *CodeBlockProcessor) Mode() block.BlockMode {
	return block.BlockModeBlock
}

// DescribeJob declares the language-refine AI job, or nil when there is no source
// to refine (the block is born COMPLETE by InitAttrs — same empty-source predicate).
// The confidence gate — take the AI's answer only when it is confident OR we have no
// confident language yet, so a non-answer ("text") never clobbers a heuristic
// language found while typing — lives in Apply, exactly as the old RunJob body did.
// The error path (status ERROR/TIMEOUT) is the framework's job (EditorService
// finish), so Apply is success-only.
func (p *CodeBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	source, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(source) == "" {
		return nil // no source: no async work (created COMPLETE)
	}

	currentLang, _ := blk.Attrs["language"].(string)
	method, _ := blk.Attrs["detectionMethod"].(string)
	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    "Refining language...",
		Work: func() (any, error) {
			if p.svc.AI == nil {
				return nil, fmt.Errorf("AI detection failed: AI service unavailable")
			}
			lang, err := p.svc.AI.RefineLanguage(source, currentLang, method)
			if err != nil {
				return nil, fmt.Errorf("AI detection failed: %w", err)
			}
			return lang, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			lang, _ := result.(string)
			// Read LIVE, not from the describe-time closure: a manual pick made
			// while this job was in flight still wins — the job settles the
			// status and writes nothing else.
			method, _ := b.Attrs["detectionMethod"].(string)
			if method != "manual" &&
				(lheur.IsConfidentLanguage(lang) || !lheur.IsConfidentLanguage(currentLang)) {
				if lang != "" {
					b.Attrs["language"] = lang
					b.Attrs["detectionMethod"] = "ai"
				}
			}
			b.Attrs["status"] = block.BlockStatusComplete
			delete(b.Attrs, "hint")
		},
	}
}

// RawContent returns the source text this block was built from (block.RawContenter).
func (p *CodeBlockProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}

// Locators a code block's segments are named by: its source and, when it has
// been given one, the file it stands for.
const (
	CodeSourceLocator   = "source"
	CodeFilenameLocator = "filename"
)

// codeLocator mints and reads code's {slot, hash} locator — the shared
// slottedLocator (slotted_locator.go), which every kind whose reading is its
// stored bytes verbatim uses the same way.
var codeLocator = slottedLocator{Kind: "code"}

// mintLocator builds the locator for slot: the slot name and a digest of the
// bytes currently read out of it.
func (p *CodeBlockProcessor) mintLocator(slot, text string) string {
	return codeLocator.Mint(slot, text)
}

// slotText returns blk's current stored text for slot, and whether slot is
// one this processor has ever minted a locator for. source and filename are
// the only two; naming anything else is a locator this processor never made.
func (p *CodeBlockProcessor) slotText(blk *block.SieveBlock, slot string) (string, bool) {
	switch slot {
	case CodeSourceLocator:
		return p.RawContent(*blk), true
	case CodeFilenameLocator:
		filename, _ := blk.Attrs[CodeFilenameLocator].(string)
		return filename, true
	}
	return "", false
}

// readLocator answers which slot locator names and whether it still names
// that slot's CURRENT bytes, given blk's live payload.
func (p *CodeBlockProcessor) readLocator(blk *block.SieveBlock, locator string) (slot, text string, err error) {
	return codeLocator.Read(locator, func(slot string) (string, bool) { return p.slotText(blk, slot) })
}

// NormalisedText makes a code block a TextBearer. Its source is CODE — a
// spell checker reads prose and nothing else, and the class is how it knows to
// leave a variable name alone — and a filename it carries is a label. Both
// segments are the stored bytes verbatim, and each carries a locator minted
// from its own slot and bytes (mintLocator).
func (p *CodeBlockProcessor) NormalisedText(blk *block.SieveBlock) []domain.TextSegment {
	if blk == nil {
		return nil
	}
	source := p.RawContent(*blk)
	segments := []domain.TextSegment{{
		Locator: p.mintLocator(CodeSourceLocator, source),
		Text:    source,
		Class:   domain.TextClassCode,
	}}
	if filename, _ := blk.Attrs["filename"].(string); filename != "" {
		segments = append(segments, domain.TextSegment{
			Locator: p.mintLocator(CodeFilenameLocator, filename),
			Text:    filename,
			Class:   domain.TextClassLabel,
		})
	}
	return segments
}

// UpdateText makes code a TextUpdater: its segments — source and, when
// present, filename — are each independently writable.
//
// CODE HAS NO PARSE: a segment's reading IS the stored bytes of the slot its
// locator names, so a resolved run addresses those bytes directly and a
// write is one splice — there is no map back through markup to derive, as
// prose's ProseReading must (prose_reading.go). The batch mechanics —
// validate every edit against its slot's current text, splice back to
// front, all-or-nothing — are identityTextEditor's (identity_text_editor.go),
// shared with diagram, the other kind whose reading is its stored bytes.
func (p *CodeBlockProcessor) UpdateText(blk *block.SieveBlock, edits []domain.TextEdit) error {
	if blk == nil {
		return fmt.Errorf("%w: code: no block to update", block.ErrTextMalformed)
	}
	if len(edits) == 0 {
		return nil
	}
	editor := identityTextEditor{Kind: "code", ReadLocator: func(locator string) (string, string, error) {
		return p.readLocator(blk, locator)
	}}
	finalText, err := editor.Apply(edits)
	if err != nil {
		return err
	}
	if blk.Attrs == nil {
		blk.Attrs = map[string]interface{}{}
	}
	for slot, text := range finalText {
		blk.Attrs[slot] = text
	}
	return nil
}

// ContentIsMarkdown reports whether this block's source is itself document
// markdown (block.MarkdownContenter): embedding such a block in the document
// inserts the source directly rather than a ```markdown fence.
func (p *CodeBlockProcessor) ContentIsMarkdown(blk block.SieveBlock) bool {
	lang, _ := blk.Attrs["language"].(string)
	lang = strings.ToLower(strings.TrimSpace(lang))
	return lang == "markdown" || lang == "md"
}

func (p *CodeBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	source, _ := blk.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	lang, _ := blk.Attrs["language"].(string)
	fence := getFence(source)
	return fence + lang + "\n" + source + "\n" + fence
}

// Move this outside to the package level
var backtickRegex = regexp.MustCompile("`+")

func getFence(content string) string {
	runs := backtickRegex.FindAllString(content, -1)

	longest := 0
	for _, r := range runs {
		if len(r) > longest {
			longest = len(r)
		}
	}

	// You can use a simple max helper or manual comparison
	fenceLen := longest + 1
	if fenceLen < 3 {
		fenceLen = 3
	}

	return strings.Repeat("`", fenceLen)
}
