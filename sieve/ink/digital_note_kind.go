package ink

import (
	"fmt"
	"strconv"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
)

// KindDigitalNote is the block kind of a Digital Note.
const KindDigitalNote = "digital-note"

// StrokesKey is the asset key of a StrokeBasedNote's log, its source.
const StrokesKey = "strokes.jsonl"

// Provenance is where a Digital Note's log comes from, and how far this Sieve holds it.
type Provenance struct {
	// Companion is the companion's identity on the link.
	Companion string
	// SourceID is the companion's note id.
	SourceID link.ID
	// SyncedSeq is the seq of the last record of the source these attrs describe; the source asset
	// holds at least that far.
	SyncedSeq uint32
}

// DigitalNoteKind is the BlockProcessor of kind digital-note: a block that describes a note and
// carries none of its ink (contract §5). Its attrs are title, note (created, pageAspect,
// template, pages), note_device, note_companion, note_source_id, note_synced_seq and source,
// the absolute address of the source asset. It is held as a block container, is never built
// from pasted content and runs no job.
type DigitalNoteKind struct {
	block.FencedSerializer
	block.FencedDeserializer
}

var (
	_ block.BlockProcessor = DigitalNoteKind{}
	_ block.FaceBearer     = DigitalNoteKind{}
)

// NewDigitalNoteKind is the processor of kind digital-note.
func NewDigitalNoteKind() DigitalNoteKind {
	return DigitalNoteKind{FencedDeserializer: block.FencedDeserializer{Kind: KindDigitalNote}}
}

func (k DigitalNoteKind) Kind() string { return KindDigitalNote }

// Attrs are the attrs describing note, as replayed, from p; they carry no id and no source,
// which InitAttrs sets.
func (k DigitalNoteKind) Attrs(note *StrokeBasedNote, p Provenance) map[string]interface{} {
	h := note.Header()
	pages := make([]interface{}, 0, note.PageCount())
	for _, page := range note.Pages() {
		pages = append(pages, map[string]interface{}{
			"id": page.ID.String(), "template": k.template(page.Template), "bounds": page.Bounds.String(),
		})
	}
	return map[string]interface{}{
		"title": h.Title,
		"note": map[string]interface{}{
			"created":    note.Created(),
			"pageAspect": k.number(h.PageAspect),
			"template":   k.template(h.Template),
			"pages":      pages,
		},
		"note_device":     map[string]interface{}{"id": h.Device.ID, "name": h.Device.Name, "model": h.Device.Model},
		"note_companion":  p.Companion,
		"note_source_id":  p.SourceID.String(),
		"note_synced_seq": int(p.SyncedSeq),
	}
}

// InitAttrs is the attrs of an empty note, overridden by overrides, with id and source pinned.
func (k DigitalNoteKind) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := k.Attrs(NewHeaderFold(id), Provenance{})
	attrs["note_source_id"] = ""
	for key, v := range overrides {
		attrs[key] = v
	}
	attrs["id"] = id
	attrs["source"] = domain.NewLeafAddress(id, StrokesKey).String()
	return attrs
}

// Face is title, page count, the device's name, source type, provenance and synced seq, for .meta.
func (k DigitalNoteKind) Face(b domain.SieveBlock) map[string]string {
	note, _ := b.Attrs["note"].(map[string]interface{})
	pages, _ := note["pages"].([]interface{})
	device, _ := b.Attrs["note_device"].(map[string]interface{})
	name, _ := device["name"].(string)
	return map[string]string{
		"note_title":      b.StringAttr("title"),
		"note_pages":      strconv.Itoa(len(pages)),
		"note_device":     name,
		"note_source":     "strokes",
		"note_source_id":  b.StringAttr("note_source_id"),
		"note_companion":  b.StringAttr("note_companion"),
		"note_synced_seq": fmt.Sprint(b.Attrs["note_synced_seq"]),
	}
}

func (k DigitalNoteKind) IsSupportedContent([]block.ContentEntry) block.SupportedActions {
	return block.SupportedActions{Kind: KindDigitalNote}
}

func (k DigitalNoteKind) Transform([]block.ContentEntry, string, string, block.Action) map[string]interface{} {
	return nil
}

func (k DigitalNoteKind) DescribeJob(block.JobContext) *block.ProcessorJob { return nil }
func (k DigitalNoteKind) OnChange(*domain.SieveBlock)                      {}
func (k DigitalNoteKind) Mode() block.BlockMode                            { return block.BlockModeBlock }

func (k DigitalNoteKind) BuildContext(domain.SieveBlock, block.DocView, map[string]bool) block.AIContext {
	return block.AIContext{}
}

// MarkdownRepresentation names the note; its ink has no markdown form.
func (k DigitalNoteKind) MarkdownRepresentation(b domain.SieveBlock, _ string) string {
	return fmt.Sprintf("> Digital note: %s (%s pages)", b.StringAttr("title"), k.Face(b)["note_pages"])
}

// template is a TemplateRef as an attr: nil, or {id, params} with params by name.
func (k DigitalNoteKind) template(t *link.Template) interface{} {
	if t == nil {
		return nil
	}
	params := map[string]interface{}{}
	for _, p := range t.Params {
		params[p.Name] = k.number(p.Value)
	}
	return map[string]interface{}{"id": t.ID, "params": params}
}

// number is f as the float64 of its shortest binary32 form, so the YAML reads as the log does.
func (k DigitalNoteKind) number(f float32) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(float64(f), 'g', -1, 32), 64)
	return v
}
