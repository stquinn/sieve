package ink

import (
	"encoding/json"
	"fmt"
	"maps"
	"strconv"
	"strings"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
)

// KindDigitalNote is the block kind of a Digital Note.
const KindDigitalNote = "digital-note"

// StrokesKey is the asset key of a StrokeBasedNote's log, its source.
const StrokesKey = "strokes.jsonl"

// metaSent is the .meta key of the seq of the description last sent to the tablet. A note's
// description is kept under the keys domain.NoteMetadata.WriteTo writes, its MetaKeyDescribed the
// seq of the log it is of, and who gave its name (NamedBy) under domain.MetaKeyNamedBy.
const metaSent = "note_meta_sent_seq"

// NamedBy is who gives a Digital Note the name it is called by, as its .meta note_named_by holds
// it: the namer, from its pages, unless a person or its tablet does.
type NamedBy string

const (
	// NamedByNamer is a note the namer names, its name the display_name of its description.
	NamedByNamer NamedBy = ""
	// NamedByHand is a note a person named, its name their display_name.
	NamedByHand NamedBy = domain.MetaNamedByHand
	// NamedByTablet is a note called by the title its tablet wrote, which has no display_name.
	NamedByTablet NamedBy = "tablet"
)

// Kept is whether the namer keeps the note's name and describes only the rest.
func (n NamedBy) Kept() bool { return n != NamedByNamer }

// Renamable is whether a person may name the note.
func (n NamedBy) Renamable() bool { return n != NamedByTablet }

// diaryType is the type property of a diary chunk, which its tablet names.
const diaryType = "diary"

// MaxNameBytes is the longest name META carries to the tablet (docs/ink-contract.md §7.3).
const MaxNameBytes = 512

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
// template, pages, each {id, template, bounds} and its name when it has one, and the note's
// properties when it has any), note_device, note_companion, note_source_id, note_synced_seq and
// source, the absolute address of the source asset. It is held as a block container, is never built
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
		entry := map[string]interface{}{
			"id": page.ID.String(), "template": k.template(page.Template), "bounds": page.Bounds.String(),
		}
		if name := page.Name(); name != "" {
			entry["name"] = name
		}
		pages = append(pages, entry)
	}
	header := map[string]interface{}{
		"created":    note.Created(),
		"pageAspect": k.number(h.PageAspect),
		"template":   k.template(h.Template),
		"pages":      pages,
	}
	if props := note.Properties(); len(props) > 0 {
		attr := make(map[string]interface{}, len(props))
		for key, values := range props {
			list := make([]interface{}, len(values))
			for i, v := range values {
				list[i] = v
			}
			attr[key] = list
		}
		header["properties"] = attr
	}
	return map[string]interface{}{
		"title":           h.Title,
		"note":            header,
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

// Face is title, the header's created time (note_created, RFC 3339, "" before any header), page
// count, whether a page is a whiteboard (unbounded), the device's name and id, source type,
// provenance, synced seq and the note's properties, for .meta: note_type is its type
// and note_period its period when that is a YYYY-MM month, each "" otherwise, and note_properties
// all of them as one JSON object, keys ascending, {} for none. Every one of those keys is written
// for every note, so a property removed leaves no stale value in .meta. A diary also carries
// note_named_by NamedByTablet; no other note carries note_named_by in its face, so the face never
// replaces who named it.
func (k DigitalNoteKind) Face(b domain.SieveBlock) map[string]string {
	note, _ := b.Attrs["note"].(map[string]interface{})
	pages, _ := note["pages"].([]interface{})
	device, _ := b.Attrs["note_device"].(map[string]interface{})
	name, _ := device["name"].(string)
	deviceID, _ := device["id"].(string)
	props := k.properties(note)
	period := k.period(props)
	propsJSON, _ := json.Marshal(props)
	whiteboard := false
	for _, p := range pages {
		if page, _ := p.(map[string]interface{}); page["bounds"] == link.BoundsUnbounded.String() {
			whiteboard = true
		}
	}
	created, _ := note["created"].(string)
	face := map[string]string{
		"note_title":      b.StringAttr("title"),
		"note_created":    created,
		"note_pages":      strconv.Itoa(len(pages)),
		"note_device":     name,
		"note_source":     "strokes",
		"note_source_id":  b.StringAttr("note_source_id"),
		"note_companion":  b.StringAttr("note_companion"),
		"note_synced_seq": fmt.Sprint(b.Attrs["note_synced_seq"]),
		"note_whiteboard": strconv.FormatBool(whiteboard),
		"note_device_id":  deviceID,
		"note_type":       props.One("type"),
		"note_period":     period,
		"note_properties": string(propsJSON),
	}
	if props.One("type") == diaryType {
		face[domain.MetaKeyNamedBy] = string(NamedByTablet)
	}
	return face
}

// properties are the note's properties as the note attr holds them, none when it holds none.
func (k DigitalNoteKind) properties(note map[string]interface{}) Properties {
	held, _ := note["properties"].(map[string]interface{})
	props := Properties{}
	for key, v := range held {
		list, _ := v.([]interface{})
		for _, value := range list {
			if text, ok := value.(string); ok {
				props[key] = append(props[key], text)
			}
		}
	}
	return props
}

// period is the period of a note with props when it is a YYYY-MM month, otherwise "".
func (k DigitalNoteKind) period(props Properties) string {
	period := props.One("period")
	if _, err := time.Parse("2006-01", period); err != nil {
		return ""
	}
	return period
}

// created is the time an RFC 3339 created stamp names; zero when it names none.
func (k DigitalNoteKind) created(stamp string) time.Time {
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return time.Time{}
	}
	return t
}

// pageFor is the id of the page a note whose attrs are attrs opens at for the day named day: its
// last page named day, else its last page; "" when it has no pages.
func (k DigitalNoteKind) pageFor(attrs map[string]interface{}, day string) string {
	note, _ := attrs["note"].(map[string]interface{})
	pages, _ := note["pages"].([]interface{})
	last := ""
	for i := len(pages) - 1; i >= 0; i-- {
		page, _ := pages[i].(map[string]interface{})
		id, _ := page["id"].(string)
		if last == "" {
			last = id
		}
		if name, _ := page["name"].(string); name == day && id != "" {
			return id
		}
	}
	return last
}

// Lifted is meta, a note's .meta as found, with note_whiteboard read from the block load gives
// when meta lacks it: a face saved before that field existed. meta itself is returned when it has
// note_whiteboard, and when load fails.
func (k DigitalNoteKind) Lifted(meta map[string]string, load func() (domain.SieveBlock, error)) map[string]string {
	if _, ok := meta["note_whiteboard"]; ok {
		return meta
	}
	b, err := load()
	if err != nil {
		return meta
	}
	lifted := maps.Clone(meta)
	lifted["note_whiteboard"] = k.Face(b)["note_whiteboard"]
	return lifted
}

// Name is what a note is called wherever it is shown: the name Sieve gave it (given), when there is
// one, otherwise tablet, the title the tablet wrote.
func (k DigitalNoteKind) Name(meta map[string]string, tablet string) string {
	if given := k.given(meta); given != "" {
		return given
	}
	return tablet
}

// given is the name Sieve gave the note, the display_name of meta; "" when there is none or the
// note is NamedByTablet.
func (k DigitalNoteKind) given(meta map[string]string) string {
	if given := meta["display_name"]; given != "null" && k.NamedBy(meta) != NamedByTablet {
		return given
	}
	return ""
}

// UntitledNotebook is what a Digital Note with no name and no title from its tablet is called.
const UntitledNotebook = "Untitled notebook"

// Called is Name, or UntitledNotebook when that is blank.
func (k DigitalNoteKind) Called(meta map[string]string, tablet string) string {
	if name := strings.TrimSpace(k.Name(meta, tablet)); name != "" {
		return name
	}
	return UntitledNotebook
}

// ContainerName is Name, with the tablet's title read from the block.
func (k DigitalNoteKind) ContainerName(b domain.SieveBlock, meta map[string]string) string {
	return k.Name(meta, b.StringAttr("title"))
}

// Describe writes d into meta as the description of the note's log to seq, as
// domain.NoteMetadata.WriteTo writes it, keeping the note's name when its NamedBy is Kept.
func (k DigitalNoteKind) Describe(meta domain.DocumentMeta, d domain.NoteMetadata, seq uint32) {
	d.WriteTo(meta, k.NamedBy(meta.All()).Kept(), uint64(seq))
}

// NameByHand writes into meta name as the note's name given by a person, which Describe keeps and
// the tablet is sent again. A blank name clears it: the note is called by its tablet's title, its
// description is of no seq, so the namer describes it again, and what is next described is sent.
func (k DigitalNoteKind) NameByHand(meta domain.DocumentMeta, name string) {
	meta.SetDisplayName(name)
	all := meta.All()
	delete(all, metaSent)
	if name != "" {
		all[domain.MetaKeyNamedBy] = string(NamedByHand)
		return
	}
	delete(all, domain.MetaKeyNamedBy)
	delete(all, domain.MetaKeyDescribed)
}

// NamedBy is who gives the note whose .meta is meta its name.
func (k DigitalNoteKind) NamedBy(meta map[string]string) NamedBy {
	return NamedBy(meta[domain.MetaKeyNamedBy])
}

// Description is the description meta holds and the seq it is of, its Title the name Sieve gave
// the note (given); false when it is of no seq and no person named the note.
func (k DigitalNoteKind) Description(meta map[string]string) (domain.NoteMetadata, uint32, bool) {
	seq := k.seq(meta, domain.MetaKeyDescribed)
	d := domain.NoteMetadata{Title: k.given(meta)}
	d.ReadFrom(meta)
	return d, seq, seq > 0 || k.NamedBy(meta) == NamedByHand
}

// DescribedSeq is the seq of the log meta's description is of, 0 when it holds none.
func (k DigitalNoteKind) DescribedSeq(meta map[string]string) uint32 {
	return k.seq(meta, domain.MetaKeyDescribed)
}

// SentSeq is the seq of the description last sent to the tablet, 0 when none was.
func (k DigitalNoteKind) SentSeq(meta map[string]string) uint32 { return k.seq(meta, metaSent) }

// Unsent is whether meta holds a description the tablet has not been sent: one of a later seq
// than the one last sent, or any since NameByHand.
func (k DigitalNoteKind) Unsent(meta map[string]string) bool {
	_, seq, ok := k.Description(meta)
	_, sent := meta[metaSent]
	return ok && (!sent || seq > k.SentSeq(meta))
}

// MarkSent records in meta that the description of the log to seq was sent to the tablet.
func (k DigitalNoteKind) MarkSent(meta domain.DocumentMeta, seq uint32) {
	meta.All()[metaSent] = strconv.FormatUint(uint64(seq), 10)
}

// seq is the seq meta holds under key, 0 when it holds none.
func (k DigitalNoteKind) seq(meta map[string]string, key string) uint32 {
	seq, _ := strconv.ParseUint(meta[key], 10, 32)
	return uint32(seq)
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

func (k DigitalNoteKind) BuildContext(domain.SieveBlock, block.ContainerView, map[string]bool) block.AIContext {
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
