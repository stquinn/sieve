package ink

import (
	"bytes"
	"fmt"
	"regexp"
	"sync"

	"sieve/sieve/ink/link"
)

// drawingStamp reads what a kept drawing was made at off its root element.
var drawingStamp = regexp.MustCompile(`^<svg\b[^>]*\sdata-ink-key="([0-9a-f-]+)"[^>]*\sdata-ink-renderer="([^"]+)"`)

// PageDrawings keeps the drawing of a Digital Note's page — the SVG a view drew of it — beside
// the note's log, one per page under a constant name: the asset notebook-{page}.svg. Keeping a
// page's drawing replaces the one before it. A drawing says what it was made at on its root
// element, data-ink-key (an OpenNote key) before data-ink-renderer (the version of the renderer
// that drew it), and is only ever handed back to that renderer, with that key. Keeping a drawing
// moves neither the block's version nor the log. It is safe for concurrent use.
type PageDrawings struct {
	notes *InkService
	// keeping is held while a drawing is saved.
	keeping sync.Mutex
}

// NewPageDrawings keeps the drawings of the pages of the notes svc holds.
func NewPageDrawings(svc *InkService) *PageDrawings {
	return &PageDrawings{notes: svc}
}

// Kept is the drawing kept for page of the Digital Note in container uuid when renderer made it,
// and the key it says it was made at; otherwise nil.
func (d *PageDrawings) Kept(uuid string, page link.ID, renderer string) (svg []byte, key string) {
	if renderer == "" {
		return nil, ""
	}
	c, err := d.notes.digitalNote(uuid)
	if err != nil {
		return nil, ""
	}
	asset, err := d.notes.containers.LoadAsset(c, d.assetKey(page))
	if err != nil {
		return nil, ""
	}
	at, by, ok := d.stamp(asset.Body())
	if !ok || by != renderer {
		return nil, ""
	}
	return asset.Body(), at
}

// Keep saves svg as the drawing of page of the Digital Note in container uuid, in place of any
// kept before. A drawing whose root does not say it was made at key is refused.
func (d *PageDrawings) Keep(uuid string, page link.ID, key string, svg []byte) error {
	if at, _, ok := d.stamp(svg); !ok || at != key {
		return fmt.Errorf("ink: the drawing of page %s of %s does not say it was made at %s", page, uuid, key)
	}
	d.keeping.Lock()
	defer d.keeping.Unlock()
	c, err := d.notes.digitalNote(uuid)
	if err != nil {
		return err
	}
	if _, err := d.notes.containers.SaveAsset(c, d.assetKey(page), svg); err != nil {
		return fmt.Errorf("ink: keeping the drawing of page %s of %s: %w", page, uuid, err)
	}
	return nil
}

// stamp is the key and the renderer svg's root says it was made at.
func (d *PageDrawings) stamp(svg []byte) (key, renderer string, ok bool) {
	end := bytes.IndexByte(svg, '>')
	if end < 0 {
		return "", "", false
	}
	m := drawingStamp.FindSubmatch(svg[:end+1])
	if m == nil {
		return "", "", false
	}
	return string(m[1]), string(m[2]), true
}

// assetKey is the key of the asset holding page's drawing.
func (d *PageDrawings) assetKey(page link.ID) string {
	return "notebook-" + page.String() + ".svg"
}
