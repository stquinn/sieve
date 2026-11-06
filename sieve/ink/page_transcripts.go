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

// PageTranscriber transcribes a handwritten page from an image of it. ai.AIService implements it.
type PageTranscriber interface {
	// Tier is the AI's tier now; nothing is transcribed while it is domain.TierDumb.
	Tier() domain.Tier
	// TranscribePage transcribes the page of the note in container uuid whose image is the asset at page.
	TranscribePage(uuid string, page domain.Address) (domain.PageTranscript, error)
}

// DiagramDrawer draws a diagram's source as an SVG. services.PlantumlService implements it.
type DiagramDrawer interface {
	Render(source string) ([]byte, error)
}

// TranscriptListener hears that what is known of the transcript of a page changed: a transcript of it
// began, or ended in a transcript kept or in a failure. It is called on the goroutine that made the
// change and must return promptly.
type TranscriptListener interface {
	TranscriptChanged(container string, page link.ID)
}

// TranscriptStatus is whether a page has a transcript, and of which key.
type TranscriptStatus string

const (
	// TranscriptNone is a page with no transcript kept.
	TranscriptNone TranscriptStatus = "none"
	// TranscriptReady is a page whose transcript is of the key the page has now.
	TranscriptReady TranscriptStatus = "ready"
	// TranscriptStale is a page whose only transcript is of a key it no longer has.
	TranscriptStale TranscriptStatus = "stale"
)

// TranscriptUnavailable is what the transcriber is told while the AI's tier is dumb.
const TranscriptUnavailable = "No AI is configured in Settings, so nothing can transcribe this page."

// TranscriptNoDrawer is what the transcriber is told when a page could not be transcribed because nothing
// connected could draw it.
const TranscriptNoDrawer = "Nothing is open that can draw this page. Open Sieve's window and transcribe it again."

// Transcript is what is known of the transcript of one page of a note.
type Transcript struct {
	Page   link.ID
	Status TranscriptStatus
	// Key is the page key the transcript is of; "" with TranscriptNone.
	Key string
	// Blocks are the transcript, in the page's order; nil with TranscriptNone.
	Blocks []domain.SieveBlock
	// Running is a transcript of the page under way.
	Running bool
	// Available is false while nothing can transcribe a page, and Unavailable then says why.
	Available   bool
	Unavailable string
	// Failed is what went wrong the last time the page was transcribed, "" when nothing did.
	Failed string
}

// keptTranscript is a page's transcript as its asset holds it.
type keptTranscript struct {
	Key    string      `json:"key"`
	Blocks []keptBlock `json:"blocks"`
}

// keptBlock is one block of a kept transcript.
type keptBlock struct {
	ID    string                 `json:"id"`
	Kind  string                 `json:"kind"`
	Attrs map[string]interface{} `json:"attrs"`
}

// PageTranscripts makes the transcripts of synced notes' pages on demand and keeps them beside each
// note's log, one per page: the transcript of page P at key K is the asset transcript-{P}-{K}.json,
// with the SVG of each PlantUML diagram in it beside it as transcript-{P}-{K}-{block id}.svg, and
// keeping it removes the page's transcripts of other keys, and their SVGs, once K is the page's key
// at that moment. A page is transcribed by one job in the AI pool, at most one per page at a time: its
// image is drawn, the transcriber transcribes it, and its parts become blocks — a text part the prose blocks
// the document codec parses its markdown into, a diagram part a diagram block, a PlantUML one
// drawn here so that it shows. A transcript moves neither the block's version nor the log. It is
// safe for concurrent use.
type PageTranscripts struct {
	notes  *InkService
	images PageImager
	transcriber PageTranscriber
	drawer DiagramDrawer
	codec  *block.DocumentCodec
	engine *services.JobEngine

	mu sync.Mutex
	// running and failed are by container and page: a transcript under way, and what the last one
	// to fail said.
	running   map[string]bool
	failed    map[string]string
	listeners []TranscriptListener
	// keeping is held while a transcript is kept and the transcripts it supersedes removed.
	keeping sync.Mutex
}

// NewPageTranscripts keeps the transcripts of notes's pages, drawn by images, transcribed by transcriber, their
// PlantUML diagrams drawn by drawer, their text parsed by codec, transcribed in jobs on engine. A nil
// drawer leaves every PlantUML diagram undrawn.
func NewPageTranscripts(notes *InkService, images PageImager, transcriber PageTranscriber, drawer DiagramDrawer,
	codec *block.DocumentCodec, engine *services.JobEngine) *PageTranscripts {
	return &PageTranscripts{notes: notes, images: images, transcriber: transcriber, drawer: drawer, codec: codec, engine: engine,
		running: map[string]bool{}, failed: map[string]string{}}
}

// Subscribe adds l to the listeners.
func (r *PageTranscripts) Subscribe(l TranscriptListener) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listeners = append(r.listeners, l)
}

// Unsubscribe removes l.
func (r *PageTranscripts) Unsubscribe(l TranscriptListener) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listeners = slices.DeleteFunc(r.listeners, func(held TranscriptListener) bool { return held == l })
}

// Transcript is what is known of the transcript of page of the Digital Note in container uuid as the
// page stands now. A container that is not a Digital Note, or a page it does not have, is
// ErrNoSuchPage.
func (r *PageTranscripts) Transcript(uuid string, page link.ID) (Transcript, error) {
	_, key, err := r.page(uuid, page)
	if err != nil {
		return Transcript{}, err
	}
	return r.state(uuid, page, key), nil
}

// Transcribe starts transcribing page of the Digital Note in container uuid, unless it has a transcript of the
// key it has now, a transcript of it is under way, or nothing can transcribe it, and answers what is then
// known of its transcript. A container that is not a Digital Note, or a page it does not have, is
// ErrNoSuchPage.
func (r *PageTranscripts) Transcribe(uuid string, page link.ID) (Transcript, error) {
	index, key, err := r.page(uuid, page)
	if err != nil {
		return Transcript{}, err
	}
	if st := r.state(uuid, page, key); st.Status == TranscriptReady || st.Running || !st.Available {
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
		Meta: domain.JobInfo{JobID: "transcribe-page:" + id, DocID: uuid,
			Label: fmt.Sprintf("Transcribing %s, page %d", r.noteName(uuid), index+1)},
		Work: func() (any, error) { return nil, r.transcribe(uuid, page) },
		OnFinished: func(any) {
			r.finished(uuid, page, "")
		},
		OnError: func(err error) {
			logger.Warn("ink: transcript a page failed", "container", uuid, "page", page.String(), "err", err.Error())
			r.finished(uuid, page, r.failure(err))
		},
	})
	return r.state(uuid, page, key), nil
}

// Copy is what a document made from the transcript of page of the Digital Note in container uuid
// holds and is called: the transcript's blocks, ready or stale, and "{the note's name} — page {n}".
// A page with no transcript is an error; a container that is not a Digital Note, or a page it does
// not have, is ErrNoSuchPage.
func (r *PageTranscripts) Copy(uuid string, page link.ID) (string, []domain.SieveBlock, error) {
	index, key, err := r.page(uuid, page)
	if err != nil {
		return "", nil, err
	}
	st := r.state(uuid, page, key)
	if st.Status == TranscriptNone {
		return "", nil, fmt.Errorf("ink: page %s of %s has no transcript", page, uuid)
	}
	return fmt.Sprintf("%s — page %d", r.noteName(uuid), index+1), st.Blocks, nil
}

// transcribe is the job's work: the page is drawn, transcribed and made blocks, and the transcript kept.
func (r *PageTranscripts) transcribe(uuid string, page link.ID) error {
	index, _, err := r.page(uuid, page)
	if err != nil {
		return err
	}
	img, err := r.images.Image(context.Background(), uuid, index)
	if err != nil {
		return err
	}
	transcript, err := r.transcriber.TranscribePage(uuid, img.Address)
	if err != nil {
		return err
	}
	blocks, err := r.blocks(uuid, page, img.Key, transcript)
	if err != nil {
		return err
	}
	return r.keep(uuid, page, img.Key, blocks)
}

// finished is the transcript of page of uuid over, failed with failure when it is not "".
func (r *PageTranscripts) finished(uuid string, page link.ID, failure string) {
	id := uuid + "/" + page.String()
	r.mu.Lock()
	delete(r.running, id)
	if failure != "" {
		r.failed[id] = failure
	}
	r.mu.Unlock()
	r.tell(uuid, page)
}

// failure is what the transcriber is told of a transcript that ended in err.
func (r *PageTranscripts) failure(err error) string {
	if errors.Is(err, ErrNoDrawer) {
		return TranscriptNoDrawer
	}
	return "The page could not be transcribed: " + err.Error()
}

// blocks are the blocks of transcript, a transcript of page of uuid at key, in its order. A part with
// nothing in it is left out.
func (r *PageTranscripts) blocks(uuid string, page link.ID, key string, transcript domain.PageTranscript) ([]domain.SieveBlock, error) {
	var out []domain.SieveBlock
	for _, part := range transcript.Parts {
		if strings.TrimSpace(part.Type) == domain.TranscriptPartDiagram {
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
			return nil, fmt.Errorf("ink: a transcript's text: %w", err)
		}
		out = append(out, prose...)
	}
	return out, nil
}

// diagram is the diagram block of part, a part of the transcript of page of uuid at key: Mermaid
// unless part names PlantUML, and a PlantUML diagram drawn and its SVG kept beside the transcript,
// or marked as not drawn.
func (r *PageTranscripts) diagram(uuid string, page link.ID, key string, part domain.TranscriptPart) (domain.SieveBlock, error) {
	engine := "mermaid"
	if strings.EqualFold(strings.TrimSpace(part.Language), "plantuml") {
		engine = "plantuml"
	}
	registry := block.GlobalRegistry()
	id := ident.New()
	attrs, ok := registry.InitialAttrs(block.KindDiagram, id,
		map[string]interface{}{"source": strings.TrimSpace(part.Source), "diagramType": engine, "mode": "render"})
	if !ok {
		return domain.SieveBlock{}, fmt.Errorf("ink: no %s kind to hold a diagram in", block.KindDiagram)
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
		logger.Info("ink: a transcript's PlantUML diagram was not drawn", "container", uuid, "page", page.String(), "err", err.Error())
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

// notDrawn is what a transcriber is told of a diagram the drawer would not draw, err.
func (r *PageTranscripts) notDrawn(err error) error {
	if errors.Is(err, services.ErrPlantumlServerUnavailable) {
		return errors.New("no PlantUML server could be reached to draw this diagram")
	}
	return errors.New("PlantUML could not draw this diagram")
}

// keep keeps blocks as the transcript of page of uuid at key and, while key is still the page's key,
// removes the page's transcripts of every other key. Transcripts are kept one at a time.
func (r *PageTranscripts) keep(uuid string, page link.ID, key string, blocks []domain.SieveBlock) error {
	kept := keptTranscript{Key: key, Blocks: make([]keptBlock, 0, len(blocks))}
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
		return fmt.Errorf("ink: keeping the transcript of page %s of %s: %w", page, uuid, err)
	}
	if _, current, err := r.page(uuid, page); err != nil || current != key {
		return nil
	}
	prefix, own := r.assetKey(page, ""), r.assetKey(page, key)
	for _, a := range c.Assets() {
		if strings.HasPrefix(a.Key(), prefix) && !strings.HasPrefix(a.Key(), own) {
			if err := containers.DeleteAsset(c, a.Key()); err != nil {
				logger.Warn("ink: removing a superseded transcript", "container", uuid, "asset", a.Key(), "err", err.Error())
			}
		}
	}
	return nil
}

// state is what is known of the transcript of page of uuid, whose key is key now.
func (r *PageTranscripts) state(uuid string, page link.ID, key string) Transcript {
	st := Transcript{Page: page, Status: TranscriptNone, Available: true}
	if r.transcriber.Tier() == domain.TierDumb {
		st.Available, st.Unavailable = false, TranscriptUnavailable
	}
	if kept, ok := r.kept(uuid, page, key); ok {
		st.Key, st.Blocks = kept.Key, kept.blocks()
		st.Status = TranscriptStale
		if kept.Key == key {
			st.Status = TranscriptReady
		}
	}
	id := uuid + "/" + page.String()
	r.mu.Lock()
	st.Running, st.Failed = r.running[id], r.failed[id]
	r.mu.Unlock()
	return st
}

// kept is the transcript of page of uuid at key when one is kept, otherwise a transcript of it at
// another key when one is.
func (r *PageTranscripts) kept(uuid string, page link.ID, key string) (keptTranscript, bool) {
	c, err := r.notes.containers.Load(uuid)
	if err != nil {
		return keptTranscript{}, false
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
		var kept keptTranscript
		if err := json.Unmarshal(asset.Body(), &kept); err != nil {
			logger.Warn("ink: a kept transcript does not parse", "container", uuid, "asset", name, "err", err.Error())
			continue
		}
		return kept, true
	}
	return keptTranscript{}, false
}

// page is the index of page in the note in uuid as it stands now, and the page's key.
func (r *PageTranscripts) page(uuid string, page link.ID) (int, string, error) {
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

// noteName is what the note in uuid is called, or "Untitled notebook".
func (r *PageTranscripts) noteName(uuid string) string {
	if name := strings.TrimSpace(r.notes.noteName(uuid)); name != "" {
		return name
	}
	return "Untitled notebook"
}

// tell tells every listener that the transcript of page of uuid changed.
func (r *PageTranscripts) tell(uuid string, page link.ID) {
	r.mu.Lock()
	listeners := slices.Clone(r.listeners)
	r.mu.Unlock()
	for _, l := range listeners {
		l.TranscriptChanged(uuid, page)
	}
}

// assetKey is the key of the transcript of page at key, without its extension; with key "" it is the
// prefix every transcript of the page, and every SVG of one, shares.
func (r *PageTranscripts) assetKey(page link.ID, key string) string {
	if key == "" {
		return "transcript-" + page.String() + "-"
	}
	return "transcript-" + page.String() + "-" + key
}

// blocks are the kept blocks as blocks.
func (k keptTranscript) blocks() []domain.SieveBlock {
	out := make([]domain.SieveBlock, 0, len(k.Blocks))
	for _, b := range k.Blocks {
		out = append(out, domain.NewSieveBlock(b.Kind, b.ID, b.Attrs))
	}
	return out
}
