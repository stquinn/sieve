package ink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// PageReader reads a handwritten page from an image of it. ai.AIService implements it.
type PageReader interface {
	// Tier is the AI's tier now; nothing is read while it is domain.TierDumb.
	Tier() domain.Tier
	// ReadPage reads the page of the note in container uuid whose image is the asset at page.
	ReadPage(uuid string, page domain.Address) (domain.PageReading, error)
}

// DiagramDrawer draws a diagram's source as an SVG. services.PlantumlService implements it.
type DiagramDrawer interface {
	Render(source string) ([]byte, error)
}

// ReadingListener hears that what is known of the reading of a page changed: a reading of it
// began, or ended in a reading kept or in a failure. It is called on the goroutine that made the
// change and must return promptly.
type ReadingListener interface {
	ReadingChanged(container string, page link.ID)
}

// ReadingStatus is whether a page has a reading, and of which key.
type ReadingStatus string

const (
	// ReadingNone is a page with no reading kept.
	ReadingNone ReadingStatus = "none"
	// ReadingReady is a page whose reading is of the key the page has now.
	ReadingReady ReadingStatus = "ready"
	// ReadingStale is a page whose only reading is of a key it no longer has.
	ReadingStale ReadingStatus = "stale"
)

// ReadingUnavailable is what the reader is told while the AI's tier is dumb.
const ReadingUnavailable = "No AI is configured in Settings, so nothing can read this page."

// ReadingNoDrawer is what the reader is told when a page could not be read because nothing
// connected could draw it.
const ReadingNoDrawer = "Nothing is open that can draw this page. Open Sieve's window and read it again."

// Reading is what is known of the reading of one page of a note.
type Reading struct {
	Page   link.ID
	Status ReadingStatus
	// Key is the page key the reading is of; "" with ReadingNone.
	Key string
	// Blocks are the reading, in the page's order; nil with ReadingNone.
	Blocks []domain.SieveBlock
	// Running is a reading of the page under way.
	Running bool
	// Available is false while nothing can read a page, and Unavailable then says why.
	Available   bool
	Unavailable string
	// Failed is what went wrong the last time the page was read, "" when nothing did.
	Failed string
}

// keptReading is a page's reading as its asset holds it.
type keptReading struct {
	Key    string      `json:"key"`
	Blocks []keptBlock `json:"blocks"`
}

// keptBlock is one block of a kept reading.
type keptBlock struct {
	ID    string                 `json:"id"`
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
}

// PageReadings makes the readings of synced notes' pages on demand and keeps them beside each
// note's log, one per page: the reading of page P at key K is the asset reading-{P}-{K}.json,
// with the SVG of each PlantUML diagram in it beside it as reading-{P}-{K}-{block id}.svg, and
// keeping it removes the page's readings of other keys, and their SVGs, once K is the page's key
// at that moment. A page is read by one job in the AI pool, at most one per page at a time: its
// image is drawn, the reader reads it, and its parts become blocks — a text part the prose blocks
// the document codec parses its markdown into, a diagram part a diagram block, a PlantUML one
// drawn here so that it shows. A reading moves neither the block's version nor the log. It is
// safe for concurrent use.
type PageReadings struct {
	notes  *InkService
	images PageImager
	reader PageReader
	drawer DiagramDrawer
	codec  *block.DocumentCodec
	engine *services.JobEngine

	mu sync.Mutex
	// running and failed are by container and page: a reading under way, and what the last one
	// to fail said.
	running   map[string]bool
	failed    map[string]string
	listeners []ReadingListener
	// keeping is held while a reading is kept and the readings it supersedes removed.
	keeping sync.Mutex
}

// NewPageReadings keeps the readings of notes's pages, drawn by images, read by reader, their
// PlantUML diagrams drawn by drawer, their text parsed by codec, read in jobs on engine. A nil
// drawer leaves every PlantUML diagram undrawn.
func NewPageReadings(notes *InkService, images PageImager, reader PageReader, drawer DiagramDrawer,
	codec *block.DocumentCodec, engine *services.JobEngine) *PageReadings {
	return &PageReadings{notes: notes, images: images, reader: reader, drawer: drawer, codec: codec, engine: engine,
		running: map[string]bool{}, failed: map[string]string{}}
}

// Subscribe adds l to the listeners.
func (r *PageReadings) Subscribe(l ReadingListener) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listeners = append(r.listeners, l)
}

// Unsubscribe removes l.
func (r *PageReadings) Unsubscribe(l ReadingListener) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listeners = slices.DeleteFunc(r.listeners, func(held ReadingListener) bool { return held == l })
}

// Reading is what is known of the reading of page of the Digital Note in container uuid as the
// page stands now. A container that is not a Digital Note, or a page it does not have, is
// ErrNoSuchPage.
func (r *PageReadings) Reading(uuid string, page link.ID) (Reading, error) {
	_, key, err := r.page(uuid, page)
	if err != nil {
		return Reading{}, err
	}
	return r.state(uuid, page, key), nil
}

// Read starts reading page of the Digital Note in container uuid, unless it has a reading of the
// key it has now, a reading of it is under way, or nothing can read it, and answers what is then
// known of its reading. A container that is not a Digital Note, or a page it does not have, is
// ErrNoSuchPage.
func (r *PageReadings) Read(uuid string, page link.ID) (Reading, error) {
	index, key, err := r.page(uuid, page)
	if err != nil {
		return Reading{}, err
	}
	if st := r.state(uuid, page, key); st.Status == ReadingReady || st.Running || !st.Available {
		return st, nil
	}
	id := uuid + "/" + page.String()
	r.mu.Lock()
	if r.running[id] {
		r.mu.Unlock()
		return r.state(uuid, page, key), nil
	}
	r.running[id] = true
	delete(r.failed, id)
	r.mu.Unlock()
	r.tell(uuid, page)
	r.engine.Submit(services.JobDescriptor{
		Category: block.CategoryAI,
		Meta: domain.JobInfo{JobID: "read-page:" + id, DocID: uuid,
			Label: fmt.Sprintf("Reading %s, page %d", r.noteName(uuid), index+1)},
		Work: func() (any, error) { return nil, r.read(uuid, page) },
		OnFinished: func(any) {
			r.finished(uuid, page, "")
		},
		OnError: func(err error) {
			logger.Warn("ink: reading a page failed", "container", uuid, "page", page.String(), "err", err.Error())
			r.finished(uuid, page, r.failure(err))
		},
	})
	return r.state(uuid, page, key), nil
}

// Copy is what a document made from the reading of page of the Digital Note in container uuid
// holds and is called: the reading's blocks, ready or stale, and "{the note's name} — page {n}".
// A page with no reading is an error; a container that is not a Digital Note, or a page it does
// not have, is ErrNoSuchPage.
func (r *PageReadings) Copy(uuid string, page link.ID) (string, []domain.SieveBlock, error) {
	index, key, err := r.page(uuid, page)
	if err != nil {
		return "", nil, err
	}
	st := r.state(uuid, page, key)
	if st.Status == ReadingNone {
		return "", nil, fmt.Errorf("ink: page %s of %s has not been read", page, uuid)
	}
	return fmt.Sprintf("%s — page %d", r.noteName(uuid), index+1), st.Blocks, nil
}

// read is the job's work: the page is drawn, read and made blocks, and the reading kept.
func (r *PageReadings) read(uuid string, page link.ID) error {
	index, _, err := r.page(uuid, page)
	if err != nil {
		return err
	}
	img, err := r.images.Image(context.Background(), uuid, index)
	if err != nil {
		return err
	}
	reading, err := r.reader.ReadPage(uuid, img.Address)
	if err != nil {
		return err
	}
	blocks, err := r.blocks(uuid, page, img.Key, reading)
	if err != nil {
		return err
	}
	return r.keep(uuid, page, img.Key, blocks)
}

// finished is the reading of page of uuid over, failed with failure when it is not "".
func (r *PageReadings) finished(uuid string, page link.ID, failure string) {
	id := uuid + "/" + page.String()
	r.mu.Lock()
	delete(r.running, id)
	if failure != "" {
		r.failed[id] = failure
	}
	r.mu.Unlock()
	r.tell(uuid, page)
}

// failure is what the reader is told of a reading that ended in err.
func (r *PageReadings) failure(err error) string {
	if errors.Is(err, ErrNoDrawer) {
		return ReadingNoDrawer
	}
	return "The page could not be read: " + err.Error()
}

// blocks are the blocks of reading, a reading of page of uuid at key, in its order. A part with
// nothing in it is left out.
func (r *PageReadings) blocks(uuid string, page link.ID, key string, reading domain.PageReading) ([]domain.SieveBlock, error) {
	var out []domain.SieveBlock
	for _, part := range reading.Parts {
		if strings.TrimSpace(part.Type) == domain.ReadingPartDiagram {
			if strings.TrimSpace(part.Source) == "" {
				continue
			}
			blk, err := r.diagram(uuid, page, key, part)
			if err != nil {
				return nil, err
			}
			out = append(out, blk)
			continue
		}
		if strings.TrimSpace(part.Markdown) == "" {
			continue
		}
		prose, err := r.codec.Deserialize(part.Markdown)
		if err != nil {
			return nil, fmt.Errorf("ink: a reading's text: %w", err)
		}
		out = append(out, prose...)
	}
	return out, nil
}

// diagram is the diagram block of part, a part of the reading of page of uuid at key: Mermaid
// unless part names PlantUML, and a PlantUML diagram drawn and its SVG kept beside the reading,
// or marked as not drawn.
func (r *PageReadings) diagram(uuid string, page link.ID, key string, part domain.ReadingPart) (domain.SieveBlock, error) {
	engine := "mermaid"
	if strings.EqualFold(strings.TrimSpace(part.Language), "plantuml") {
		engine = "plantuml"
	}
	registry := block.GlobalRegistry()
	id := ident.New()
	attrs, ok := registry.InitialAttrs(block.KindDiagram, id,
		map[string]interface{}{"source": strings.TrimSpace(part.Source), "diagramType": engine, "mode": "render"})
	if !ok {
		return domain.SieveBlock{}, fmt.Errorf("ink: no %s kind to read a diagram into", block.KindDiagram)
	}
	blk := domain.NewSieveBlock(block.KindDiagram, id, attrs)
	drawn, elsewhere := registry.Get(block.KindDiagram).(block.DrawnElsewhere)
	if !elsewhere {
		return blk, nil
	}
	source, ok := drawn.DrawingSource(blk)
	if !ok {
		return blk, nil
	}
	if r.drawer == nil {
		drawn.NotDrawn(&blk, errors.New("PlantUML could not draw this diagram"))
		return blk, nil
	}
	svg, err := r.drawer.Render(source)
	if err != nil {
		logger.Info("ink: a reading's PlantUML diagram was not drawn", "container", uuid, "page", page.String(), "err", err.Error())
		drawn.NotDrawn(&blk, r.notDrawn(err))
		return blk, nil
	}
	c, err := r.notes.containers.Load(uuid)
	if err != nil {
		return domain.SieveBlock{}, err
	}
	asset := r.assetKey(page, key) + "-" + id + ".svg"
	if _, err := r.notes.containers.SaveAsset(c, asset, svg); err != nil {
		return domain.SieveBlock{}, fmt.Errorf("ink: keeping a diagram of page %s of %s: %w", page, uuid, err)
	}
	drawn.Drawn(&blk, domain.NewLeafAddress(uuid, asset).String())
	return blk, nil
}

// notDrawn is what a reader is told of a diagram the drawer would not draw, err.
func (r *PageReadings) notDrawn(err error) error {
	if errors.Is(err, services.ErrPlantumlServerUnavailable) {
		return errors.New("no PlantUML server could be reached to draw this diagram")
	}
	return errors.New("PlantUML could not draw this diagram")
}

// keep keeps blocks as the reading of page of uuid at key and, while key is still the page's key,
// removes the page's readings of every other key. Readings are kept one at a time.
func (r *PageReadings) keep(uuid string, page link.ID, key string, blocks []domain.SieveBlock) error {
	kept := keptReading{Key: key, Blocks: make([]keptBlock, 0, len(blocks))}
	for _, b := range blocks {
		kept.Blocks = append(kept.Blocks, keptBlock{ID: b.ID, Kind: b.Kind, Attrs: b.Attrs})
	}
	body, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	r.keeping.Lock()
	defer r.keeping.Unlock()
	containers := r.notes.containers
	c, err := containers.Load(uuid)
	if err != nil {
		return err
	}
	if _, err := containers.SaveAsset(c, r.assetKey(page, key)+".json", body); err != nil {
		return fmt.Errorf("ink: keeping the reading of page %s of %s: %w", page, uuid, err)
	}
	if _, current, err := r.page(uuid, page); err != nil || current != key {
		return nil
	}
	prefix, own := r.assetKey(page, ""), r.assetKey(page, key)
	for _, a := range c.Assets() {
		if strings.HasPrefix(a.Key(), prefix) && !strings.HasPrefix(a.Key(), own) {
			if err := containers.DeleteAsset(c, a.Key()); err != nil {
				logger.Warn("ink: removing a superseded reading", "container", uuid, "asset", a.Key(), "err", err.Error())
			}
		}
	}
	return nil
}

// state is what is known of the reading of page of uuid, whose key is key now.
func (r *PageReadings) state(uuid string, page link.ID, key string) Reading {
	st := Reading{Page: page, Status: ReadingNone, Available: true}
	if r.reader.Tier() == domain.TierDumb {
		st.Available, st.Unavailable = false, ReadingUnavailable
	}
	if kept, ok := r.kept(uuid, page, key); ok {
		st.Key, st.Blocks = kept.Key, kept.blocks()
		st.Status = ReadingStale
		if kept.Key == key {
			st.Status = ReadingReady
		}
	}
	id := uuid + "/" + page.String()
	r.mu.Lock()
	st.Running, st.Failed = r.running[id], r.failed[id]
	r.mu.Unlock()
	return st
}

// kept is the reading of page of uuid at key when one is kept, otherwise a reading of it at
// another key when one is.
func (r *PageReadings) kept(uuid string, page link.ID, key string) (keptReading, bool) {
	c, err := r.notes.containers.Load(uuid)
	if err != nil {
		return keptReading{}, false
	}
	own, prefix := r.assetKey(page, key)+".json", r.assetKey(page, "")
	names := []string{own}
	for _, a := range c.Assets() {
		if strings.HasPrefix(a.Key(), prefix) && strings.HasSuffix(a.Key(), ".json") && a.Key() != own {
			names = append(names, a.Key())
		}
	}
	for _, name := range names {
		asset, err := r.notes.containers.LoadAsset(c, name)
		if err != nil {
			continue
		}
		var kept keptReading
		if err := json.Unmarshal(asset.Body(), &kept); err != nil {
			logger.Warn("ink: a kept reading does not parse", "container", uuid, "asset", name, "err", err.Error())
			continue
		}
		return kept, true
	}
	return keptReading{}, false
}

// page is the index of page in the note in uuid as it stands now, and the page's key.
func (r *PageReadings) page(uuid string, page link.ID) (int, string, error) {
	log, err := r.notes.noteLog(uuid)
	if err != nil {
		return 0, "", err
	}
	note := ReadStrokeBasedNote(uuid, log)
	for i, at := range note.Pages() {
		if at.ID == page {
			key, err := note.PageKey(i)
			return i, key, err
		}
	}
	return 0, "", fmt.Errorf("%w: %s has no page %s", ErrNoSuchPage, uuid, page)
}

// noteName is what the note in uuid is called, or "Untitled note".
func (r *PageReadings) noteName(uuid string) string {
	if name := strings.TrimSpace(r.notes.noteName(uuid)); name != "" {
		return name
	}
	return "Untitled note"
}

// tell tells every listener that the reading of page of uuid changed.
func (r *PageReadings) tell(uuid string, page link.ID) {
	r.mu.Lock()
	listeners := slices.Clone(r.listeners)
	r.mu.Unlock()
	for _, l := range listeners {
		l.ReadingChanged(uuid, page)
	}
}

// assetKey is the key of the reading of page at key, without its extension; with key "" it is the
// prefix every reading of the page, and every SVG of one, shares.
func (r *PageReadings) assetKey(page link.ID, key string) string {
	if key == "" {
		return "reading-" + page.String() + "-"
	}
	return "reading-" + page.String() + "-" + key
}

// blocks are the kept blocks as blocks.
func (k keptReading) blocks() []domain.SieveBlock {
	out := make([]domain.SieveBlock, 0, len(k.Blocks))
	for _, b := range k.Blocks {
		out = append(out, domain.NewSieveBlock(b.Kind, b.ID, b.Attrs))
	}
	return out
}
