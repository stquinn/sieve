package ink

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
)

// KindDigitalNote is the block kind of a Digital Note.
const KindDigitalNote = "digital-note"

// StrokesKey is the asset key of a StrokeBasedNote's log, its source.
const StrokesKey = "strokes.jsonl"

// The .meta keys of a note's description beside display_name, summary and tags: its keywords and
// categories as JSON arrays of strings, the seq of the log the description is of, and the seq of
// the description last sent to the tablet.
const (
	metaKeywords   = "note_keywords"
	metaCategories = "note_categories"
	metaDescribed  = "note_meta_seq"
	metaSent       = "note_meta_sent_seq"
)

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
	_ block.ContainerNamer = DigitalNoteKind{}
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

// Name is what a note is called wherever it is shown: the name Sieve gave it, the display_name of
// its .meta, when there is one, otherwise tablet, the title the tablet wrote.
func (k DigitalNoteKind) Name(meta map[string]string, tablet string) string {
	if given := meta["display_name"]; given != "" && given != "null" {
		return given
	}
	return tablet
}

// ContainerName is Name, with the tablet's title read from the block.
func (k DigitalNoteKind) ContainerName(b domain.SieveBlock, meta map[string]string) string {
	return k.Name(meta, b.StringAttr("title"))
}

// Describe writes d into meta as the description of the note's log to seq: Title as display_name,
// Summary, Keywords as tags, and Keywords and Categories whole under the kind's own keys. A comma
// in a keyword is a semicolon in tags, whose stored form splits on commas.
func (k DigitalNoteKind) Describe(meta domain.DocumentMeta, d domain.NoteMetadata, seq uint32) {
	meta.SetDisplayName(strings.TrimSpace(d.Title))
	summary := strings.TrimSpace(d.Summary)
	if summary == "" {
		meta.SetSummary(nil)
	} else {
		meta.SetSummary(&summary)
	}
	tags := make([]string, 0, len(d.Keywords))
	for _, kw := range d.Keywords {
		if tag := strings.TrimSpace(strings.ReplaceAll(kw, ",", ";")); tag != "" {
			tags = append(tags, tag)
		}
	}
	meta.SetTags(tags)
	all := meta.All()
	all[metaKeywords], all[metaCategories] = k.terms(d.Keywords), k.terms(d.Categories)
	all[metaDescribed] = strconv.FormatUint(uint64(seq), 10)
}

// Description is the description meta holds and the seq it is of; false when it holds none.
func (k DigitalNoteKind) Description(meta map[string]string) (domain.NoteMetadata, uint32, bool) {
	seq := k.seq(meta, metaDescribed)
	if seq == 0 {
		return domain.NoteMetadata{}, 0, false
	}
	d := domain.NoteMetadata{Title: meta["display_name"], Summary: meta["summary"]}
	if d.Title == "null" {
		d.Title = ""
	}
	if d.Summary == "null" {
		d.Summary = ""
	}
	_ = json.Unmarshal([]byte(meta[metaKeywords]), &d.Keywords)
	_ = json.Unmarshal([]byte(meta[metaCategories]), &d.Categories)
	return d, seq, true
}

// DescribedSeq is the seq of the log meta's description is of, 0 when it holds none.
func (k DigitalNoteKind) DescribedSeq(meta map[string]string) uint32 {
	return k.seq(meta, metaDescribed)
}

// SentSeq is the seq of the description last sent to the tablet, 0 when none was.
func (k DigitalNoteKind) SentSeq(meta map[string]string) uint32 { return k.seq(meta, metaSent) }

// MarkSent records in meta that the description of the log to seq was sent to the tablet.
func (k DigitalNoteKind) MarkSent(meta domain.DocumentMeta, seq uint32) {
	meta.All()[metaSent] = strconv.FormatUint(uint64(seq), 10)
}

// seq is the seq meta holds under key, 0 when it holds none.
func (k DigitalNoteKind) seq(meta map[string]string, key string) uint32 {
	seq, _ := strconv.ParseUint(meta[key], 10, 32)
	return uint32(seq)
}

// terms is list as a JSON array of strings, [] for none.
func (k DigitalNoteKind) terms(list []string) string {
	if list == nil {
		list = []string{}
	}
	raw, _ := json.Marshal(list)
	return string(raw)
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
