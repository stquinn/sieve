// Package ink holds the Digital Note: its block kind, the replay of its log, and this Sieve's
// replica of a companion's notes over block containers.
package ink

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"sieve/sieve/ink/link"
)

// DigitalNote is what every consumer of a note sees, whatever holds its pages.
type DigitalNote interface {
	// ID is the uuid of the note's container in this Sieve.
	ID() string
	Title() string
	PageCount() int
}

// Page is one page of a note, without its strokes.
type Page struct {
	ID       link.ID
	Template *link.Template
	Bounds   link.Bounds
}

// StrokeBasedNote is the replay of a note's log (contract §3). Built by NewStrokeBasedNote it
// holds the strokes of every page; built by NewHeaderFold it holds the header and the page list
// only, and its Strokes and ExportPage report no strokes.
type StrokeBasedNote struct {
	id          string
	keepStrokes bool
	header      link.Record
	pages       []*notePage
	removed     map[link.ID]*notePage
}

// notePage is a page and, when the note keeps them, its strokes in the order they were added.
type notePage struct {
	Page
	strokes []link.Record
	held    map[link.ID]bool
}

var _ DigitalNote = (*StrokeBasedNote)(nil)

// NewStrokeBasedNote is the empty replay of the note in container id, keeping strokes.
func NewStrokeBasedNote(id string) *StrokeBasedNote {
	return &StrokeBasedNote{id: id, keepStrokes: true, removed: map[link.ID]*notePage{}}
}

// NewHeaderFold is the empty replay of the note in container id, keeping no strokes.
func NewHeaderFold(id string) *StrokeBasedNote {
	return &StrokeBasedNote{id: id, removed: map[link.ID]*notePage{}}
}

// ReadStrokeBasedNote replays a strokes.jsonl asset of container id, keeping strokes, up to
// the first line Read stops at.
func ReadStrokeBasedNote(id string, jsonl []byte) *StrokeBasedNote {
	n := NewStrokeBasedNote(id)
	n.Read(jsonl)
	return n
}

func (n *StrokeBasedNote) ID() string     { return n.id }
func (n *StrokeBasedNote) Title() string  { return n.header.Title }
func (n *StrokeBasedNote) PageCount() int { return len(n.pages) }

// Header is the last note-header applied; its Op is zero before any.
func (n *StrokeBasedNote) Header() link.Record { return n.header }

// Created is the header's created time as §4.1 writes it, "" before any header.
func (n *StrokeBasedNote) Created() string {
	if n.header.Op != link.OpNoteHeader {
		return ""
	}
	t := time.UnixMilli(n.header.CreatedMillis).UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000Z")
}

// Pages are the pages currently present, in order.
func (n *StrokeBasedNote) Pages() []Page {
	out := make([]Page, len(n.pages))
	for i, p := range n.pages {
		out[i] = p.Page
	}
	return out
}

// PageTemplate is the template the page at index page is drawn with: its own, otherwise the note
// header's; nil for a page out of range or when both are null.
func (n *StrokeBasedNote) PageTemplate(page int) *link.Template {
	if page < 0 || page >= len(n.pages) {
		return nil
	}
	if t := n.pages[page].Template; t != nil {
		return t
	}
	return n.header.Template
}

// Strokes are the stroke-add records of the page at index page, in the order they were added;
// nil for a page out of range or a note that keeps no strokes.
func (n *StrokeBasedNote) Strokes(page int) []link.Record {
	if page < 0 || page >= len(n.pages) {
		return nil
	}
	return append([]link.Record(nil), n.pages[page].strokes...)
}

// Inked reports whether any page present holds a stroke; false for a note that keeps no strokes.
func (n *StrokeBasedNote) Inked() bool {
	for _, p := range n.pages {
		if len(p.strokes) > 0 {
			return true
		}
	}
	return false
}

// Effect is what applying one record did to a note.
type Effect uint8

const (
	// NoEffect is a record the replay rules make a no-op.
	NoEffect Effect = iota
	// StrokeAdded is the record's stroke now present on the record's page.
	StrokeAdded
	// StrokeRemoved is the record's stroke gone from the record's page.
	StrokeRemoved
	// NoteChanged is the header or the page list changed: a page added, removed, restored or
	// given another template, or a note-header. A restored page's strokes are present again.
	NoteChanged
)

// Apply replays one record and reports what it did. Records the rules make no-ops change
// nothing: a stroke-add of an id the page holds, a removal of what is absent, a page-add of a
// present page, and any page or stroke record naming a page not currently present. A page-add of
// a removed page restores it with its strokes and the record's template; a page is inserted at
// its index, clamped to the pages present, and never moved after. A note that keeps no strokes
// reports no stroke effect.
func (n *StrokeBasedNote) Apply(r link.Record) Effect {
	switch r.Op {
	case link.OpNoteHeader:
		n.header = r
		return NoteChanged
	case link.OpPageAdd:
		if n.present(r.Page) >= 0 {
			return NoEffect
		}
		p, wasRemoved := n.removed[r.Page]
		if wasRemoved {
			delete(n.removed, r.Page)
			p.Template = r.Template
		} else {
			p = &notePage{Page: Page{ID: r.Page, Template: r.Template, Bounds: r.Bounds}, held: map[link.ID]bool{}}
		}
		at := min(int(r.Index), len(n.pages))
		n.pages = slices.Insert(n.pages, at, p)
		return NoteChanged
	case link.OpPageRemove:
		if i := n.present(r.Page); i >= 0 {
			n.removed[r.Page] = n.pages[i]
			n.pages = slices.Delete(n.pages, i, i+1)
			return NoteChanged
		}
	case link.OpPageTemplate:
		if i := n.present(r.Page); i >= 0 {
			n.pages[i].Template = r.Template
			return NoteChanged
		}
	case link.OpStrokeAdd:
		if i := n.present(r.Page); i >= 0 && n.keepStrokes && !n.pages[i].held[r.Stroke] {
			n.pages[i].strokes = append(n.pages[i].strokes, r)
			n.pages[i].held[r.Stroke] = true
			return StrokeAdded
		}
	case link.OpStrokeRemove:
		if i := n.present(r.Page); i >= 0 && n.pages[i].held[r.Stroke] {
			p := n.pages[i]
			delete(p.held, r.Stroke)
			for j, s := range p.strokes {
				if s.Stroke == r.Stroke {
					p.strokes = slices.Delete(p.strokes, j, j+1)
					break
				}
			}
			return StrokeRemoved
		}
	}
	return NoEffect
}

// present is the index of the page among the pages present, -1 when it is not present.
func (n *StrokeBasedNote) present(page link.ID) int {
	for i, p := range n.pages {
		if p.ID == page {
			return i
		}
	}
	return -1
}

// Read replays the §4.1 lines of jsonl in order, from the note's start, and returns the cursor
// they reach and the length of the prefix they fill. It stops at the first line that has no
// "\n", does not parse, or is not the next seq, and leaves that line and what follows unread.
func (n *StrokeBasedNote) Read(jsonl []byte) (link.Cursor, int) {
	var cursor link.Cursor
	read := 0
	for read < len(jsonl) {
		end := bytes.IndexByte(jsonl[read:], '\n')
		if end < 0 {
			break
		}
		r, err := link.ParseJSONLine(jsonl[read : read+end+1])
		if err != nil {
			break
		}
		body, err := r.Body()
		if err != nil {
			break
		}
		if err := cursor.Accept(r, body); err != nil {
			break
		}
		n.Apply(r)
		read += end + 1
	}
	return cursor, read
}

// ExportPage is the page at index page in the §4.2 export shape, which the ink renderer takes:
// the note header, with the template that page is drawn with, and the page's strokes, each point
// carrying size 0.
func (n *StrokeBasedNote) ExportPage(page int) ([]byte, error) {
	if page < 0 || page >= len(n.pages) {
		return nil, fmt.Errorf("ink: page %d of %d", page, len(n.pages))
	}
	h := n.header
	out := exportPage{
		Note: exportNote{ID: h.Note.String(), Created: n.Created(), Title: h.Title, PageAspect: h.PageAspect,
			Template: exportTemplate{n.PageTemplate(page)}, Device: exportDevice{h.Device.ID, h.Device.Name, h.Device.Model}},
		Strokes: []exportStroke{},
	}
	for _, s := range n.pages[page].strokes {
		out.Strokes = append(out.Strokes, newExportStroke(s))
	}
	return json.Marshal(out)
}

// pageKeyDigits is how many hex digits of its hash a page key keeps: 64 bits.
const pageKeyDigits = 16

// PageKey names what is on the page at index page: the first 16 lowercase hex digits of the
// SHA-256 of the JSON of the page's id, the note's pageAspect, the template the page is drawn
// with, its bounds and its strokes as ExportPage gives them, in that order. The JSON is
// deterministic, so an unchanged page has the same key on every run and machine; a stroke added,
// removed or changed, another aspect, template or bounds, or another page gives another key. The
// note's title, created time and device are not on the page and do not move it.
func (n *StrokeBasedNote) PageKey(page int) (string, error) {
	if page < 0 || page >= len(n.pages) {
		return "", fmt.Errorf("ink: page %d of %d", page, len(n.pages))
	}
	p := n.pages[page]
	content := pageContent{Page: p.ID.String(), PageAspect: n.header.PageAspect, Template: exportTemplate{n.PageTemplate(page)},
		Bounds: p.Bounds.String(), Strokes: make([]exportStroke, 0, len(p.strokes))}
	for _, s := range p.strokes {
		content.Strokes = append(content.Strokes, newExportStroke(s))
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:pageKeyDigits], nil
}

type pageContent struct {
	Page       string         `json:"page"`
	PageAspect float32        `json:"pageAspect"`
	Template   exportTemplate `json:"template"`
	Bounds     string         `json:"bounds"`
	Strokes    []exportStroke `json:"strokes"`
}

// newExportStroke is the stroke of stroke-add record s in the §4.2 export shape.
func newExportStroke(s link.Record) exportStroke {
	points := make([]exportPoint, len(s.Points))
	for i, p := range s.Points {
		points[i] = exportPoint{p.X, p.Y, p.Pressure, p.TMillis, p.TiltX, p.TiltY, 0}
	}
	return exportStroke{s.Stroke.String(), s.Tool.String(), s.WidthClass, s.StartMillis, points}
}

// The §4.2 export page, keys in the contract's order.
type (
	exportPage struct {
		Note    exportNote     `json:"note"`
		Strokes []exportStroke `json:"strokes"`
	}
	exportNote struct {
		ID         string         `json:"id"`
		Created    string         `json:"created"`
		Title      string         `json:"title"`
		PageAspect float32        `json:"pageAspect"`
		Template   exportTemplate `json:"template"`
		Device     exportDevice   `json:"device"`
	}
	exportDevice struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Model string `json:"model"`
	}
	exportStroke struct {
		ID          string        `json:"id"`
		Tool        string        `json:"tool"`
		WidthClass  uint8         `json:"widthClass"`
		StartMillis uint64        `json:"startMillis"`
		Points      []exportPoint `json:"points"`
	}
	exportPoint struct {
		X        float32 `json:"x"`
		Y        float32 `json:"y"`
		Pressure float32 `json:"pressure"`
		TMillis  uint32  `json:"tMillis"`
		TiltX    int8    `json:"tiltX"`
		TiltY    int8    `json:"tiltY"`
		Size     float32 `json:"size"`
	}
	// exportTemplate is a TemplateRef: null, or {"id", "params"} with params in their order.
	exportTemplate struct{ t *link.Template }
)

func (e exportTemplate) MarshalJSON() ([]byte, error) {
	if e.t == nil {
		return []byte("null"), nil
	}
	id, err := json.Marshal(e.t.ID)
	if err != nil {
		return nil, err
	}
	b := append(append([]byte(`{"id":`), id...), `,"params":{`...)
	for i, p := range e.t.Params {
		name, err := json.Marshal(p.Name)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(p.Value)
		if err != nil {
			return nil, err
		}
		if i > 0 {
			b = append(b, ',')
		}
		b = append(append(append(b, name...), ':'), value...)
	}
	return append(b, "}}"...), nil
}
