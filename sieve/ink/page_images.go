package ink

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/store"
)

// ErrNoDrawer is a page that cannot be drawn now because nothing connected can draw one.
var ErrNoDrawer = errors.New("ink: nothing connected can draw a page")

// pngSignature is the first eight bytes of every PNG.
var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// PageDrawing is one page as a drawer needs it, with nothing else to fetch.
type PageDrawing struct {
	// Container is the uuid of the note's container.
	Container string
	Page      link.ID
	// Key is the page's PageKey.
	Key string
	// Bounds says how the page is framed: a fixed page is drawn whole, an unbounded one framed
	// to all its ink.
	Bounds link.Bounds
	// Export is the page in the §4.2 export shape.
	Export []byte
}

// PageDrawer draws a page as a PNG. An error wrapping ErrNoDrawer is nothing connected that can
// draw; any other error is a drawing that failed. DrawPage may be called from any goroutine, and
// it must answer or fail in a bounded time whatever ctx does.
type PageDrawer interface {
	DrawPage(ctx context.Context, page PageDrawing) ([]byte, error)
}

// PageImage is the image of one page of a note, kept as an asset of the note's container.
type PageImage struct {
	// Key is the PageKey the page was drawn at.
	Key string
	// Address is the asset's absolute address, sieve://{container}/{asset key}.
	Address domain.Address
	// Asset is the asset; its Body is the PNG.
	Asset store.AssetStorable
}

// PageImages makes the images of synced notes' pages and keeps them beside each note's log, one
// per page: the image of page P drawn at key K is the asset page-{P}-{K}.png, and saving it
// removes the page's images of other keys once K is the page's key at that moment. Saving an image
// moves neither the block's version nor the log. It is safe for concurrent use.
type PageImages struct {
	notes  *InkService
	drawer PageDrawer

	mu sync.Mutex
	// drawing is each drawing under way, by container and asset key.
	drawing map[string]*pageDraw
	// saving is held while an image is saved and the images it supersedes removed.
	saving sync.Mutex
}

// pageDraw is one drawing that every request for its page at its key waits on.
type pageDraw struct {
	done  chan struct{}
	image PageImage
	err   error
}

// NewPageImages keeps the images of notes' pages, read through notes and drawn by drawer. A nil
// drawer is nothing connected that can draw.
func NewPageImages(notes *InkService, drawer PageDrawer) *PageImages {
	return &PageImages{notes: notes, drawer: drawer, drawing: map[string]*pageDraw{}}
}

// Image is the image of the page at index page of the Digital Note in container uuid as the page
// stands now, the open session's records included. An image already kept for the page's key is
// returned as it is; otherwise the page is drawn and kept. Concurrent requests for one page at one
// key share one drawing, and a request that gives up on ctx leaves the drawing to finish for the
// others. No lock of the service or of a session is held while the page is drawn. A container that
// is not a Digital Note, or a page it does not have, is ErrNoSuchPage; nothing connected that can
// draw is ErrNoDrawer.
func (p *PageImages) Image(ctx context.Context, uuid string, page int) (PageImage, error) {
	drawing, err := p.current(uuid, page)
	if err != nil {
		return PageImage{}, err
	}
	asset := p.assetKey(drawing.Page, drawing.Key)
	if img, ok := p.kept(uuid, asset, drawing.Key); ok {
		return img, nil
	}
	p.mu.Lock()
	d, running := p.drawing[uuid+"/"+asset]
	if !running {
		d = &pageDraw{done: make(chan struct{})}
		p.drawing[uuid+"/"+asset] = d
		go p.draw(context.WithoutCancel(ctx), d, drawing, asset)
	}
	p.mu.Unlock()
	select {
	case <-d.done:
		return d.image, d.err
	case <-ctx.Done():
		return PageImage{}, ctx.Err()
	}
}

// current is the page at index page of the note in uuid as it stands now, ready to draw.
func (p *PageImages) current(uuid string, page int) (PageDrawing, error) {
	log, err := p.notes.noteLog(uuid)
	if err != nil {
		return PageDrawing{}, err
	}
	note := ReadStrokeBasedNote(uuid, log)
	if page < 0 || page >= note.PageCount() {
		return PageDrawing{}, fmt.Errorf("%w: %s has %d pages, not page %d", ErrNoSuchPage, uuid, note.PageCount(), page)
	}
	export, err := note.ExportPage(page)
	if err != nil {
		return PageDrawing{}, err
	}
	key, err := note.PageKey(page)
	if err != nil {
		return PageDrawing{}, err
	}
	at := note.Pages()[page]
	return PageDrawing{Container: uuid, Page: at.ID, Key: key, Bounds: at.Bounds, Export: export}, nil
}

// draw makes d's image of the page and saves it as asset, then releases d's waiters.
func (p *PageImages) draw(ctx context.Context, d *pageDraw, page PageDrawing, asset string) {
	defer func() {
		p.mu.Lock()
		delete(p.drawing, page.Container+"/"+asset)
		p.mu.Unlock()
		close(d.done)
	}()
	if p.drawer == nil {
		d.err = ErrNoDrawer
		return
	}
	png, err := p.drawer.DrawPage(ctx, page)
	if err != nil {
		d.err = fmt.Errorf("ink: drawing page %s of %s: %w", page.Page, page.Container, err)
		return
	}
	if !bytes.HasPrefix(png, pngSignature) {
		d.err = fmt.Errorf("ink: the drawing of page %s of %s is not a PNG", page.Page, page.Container)
		return
	}
	d.image, d.err = p.save(page, asset, png)
}

// save keeps png as the page's image at its key and, while that key is still the page's key,
// removes the page's images of every other key. Saves are one at a time, so two drawings of one
// page never remove each other's image.
func (p *PageImages) save(page PageDrawing, asset string, png []byte) (PageImage, error) {
	p.saving.Lock()
	defer p.saving.Unlock()
	containers := p.notes.containers
	c, err := containers.Load(page.Container)
	if err != nil {
		return PageImage{}, err
	}
	saved, err := containers.SaveAsset(c, asset, png)
	if err != nil {
		return PageImage{}, fmt.Errorf("ink: keeping the image of page %s of %s: %w", page.Page, page.Container, err)
	}
	if p.isCurrent(page) {
		prefix := p.assetKey(page.Page, "")
		for _, a := range c.Assets() {
			if strings.HasPrefix(a.Key(), prefix) && a.Key() != asset {
				if err := containers.DeleteAsset(c, a.Key()); err != nil {
					logger.Warn("ink: removing a superseded page image", "container", page.Container, "asset", a.Key(), "err", err.Error())
				}
			}
		}
	}
	return PageImage{Key: page.Key, Address: domain.NewLeafAddress(page.Container, asset), Asset: saved}, nil
}

// isCurrent reports whether page's key is still the key of that page of its note.
func (p *PageImages) isCurrent(page PageDrawing) bool {
	log, err := p.notes.noteLog(page.Container)
	if err != nil {
		return false
	}
	note := ReadStrokeBasedNote(page.Container, log)
	for i, at := range note.Pages() {
		if at.ID == page.Page {
			key, err := note.PageKey(i)
			return err == nil && key == page.Key
		}
	}
	return false
}

// kept is the image already kept in uuid as asset, drawn at key.
func (p *PageImages) kept(uuid, asset, key string) (PageImage, bool) {
	c, err := p.notes.containers.Load(uuid)
	if err != nil {
		return PageImage{}, false
	}
	a, err := p.notes.containers.LoadAsset(c, asset)
	if err != nil {
		return PageImage{}, false
	}
	return PageImage{Key: key, Address: domain.NewLeafAddress(uuid, asset), Asset: a}, true
}

// assetKey is the key of the image of page drawn at key; with key "" it is the prefix every image
// of the page shares.
func (p *PageImages) assetKey(page link.ID, key string) string {
	if key == "" {
		return "page-" + page.String() + "-"
	}
	return "page-" + page.String() + "-" + key + ".png"
}
