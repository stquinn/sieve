package ink

import (
	"bytes"
	"context"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
)

// fakeDrawer draws a page as the PNG signature followed by its key. While hold is set each
// drawing waits for it to close, and during runs inside each drawing before it answers.
type fakeDrawer struct {
	mu     sync.Mutex
	drawn  []PageDrawing
	err    error
	hold   chan struct{}
	during func()
	notPNG bool
}

func (d *fakeDrawer) DrawPage(_ context.Context, page PageDrawing) ([]byte, error) {
	d.mu.Lock()
	d.drawn = append(d.drawn, page)
	hold, during, err, notPNG := d.hold, d.during, d.err, d.notPNG
	d.mu.Unlock()
	if during != nil {
		during()
	}
	if hold != nil {
		<-hold
	}
	if err != nil {
		return nil, err
	}
	if notPNG {
		return []byte("<svg/>"), nil
	}
	return append(append([]byte(nil), pngSignature...), page.Key...), nil
}

func (d *fakeDrawer) drawings() []PageDrawing {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]PageDrawing(nil), d.drawn...)
}

// imagesRig is a session's replica of one note, appended to record by record, the service reading
// it, and the page images over that service.
type imagesRig struct {
	*replicaRig
	svc     *InkService
	replica *NoteReplica
	drawer  *fakeDrawer
	images  *PageImages
	// appended is every record appended so far.
	appended []link.Record
}

// newImagesRig opens the replica of noteID in a running session and appends records to it, caught
// up, so its block is saved.
func newImagesRig(t *testing.T, records ...link.Record) *imagesRig {
	t.Helper()
	rig := &imagesRig{replicaRig: newReplicaRig(t, nil), drawer: &fakeDrawer{}}
	rig.svc = NewInkService(nil, rig.containers, nil, nil)
	rig.svc.run = &sessionRun{replicas: rig.replicas, link: namedLink{identity: companionID}}
	opened, err := rig.replicas.Open(noteID)
	if err != nil {
		t.Fatal(err)
	}
	rig.replica = opened.(*NoteReplica)
	rig.append(records...)
	if err := rig.replicas.CaughtUp(noteID); err != nil {
		t.Fatal(err)
	}
	rig.images = NewPageImages(rig.svc, rig.drawer)
	return rig
}

// append appends records to the replica, numbering them on from what it holds. It may be called
// from any goroutine, so it reports a failure without stopping the test.
func (rig *imagesRig) append(records ...link.Record) {
	rig.t.Helper()
	for _, r := range records {
		r.Seq = uint32(len(rig.appended) + 1)
		body, err := r.Body()
		if err == nil {
			err = rig.replica.Append(r, body)
		}
		if err != nil {
			rig.t.Errorf("Append seq %d: %v", r.Seq, err)
			return
		}
		rig.appended = append(rig.appended, r)
	}
}

func (rig *imagesRig) uuid() string { return rig.replica.UUID() }

// image asks for the image of the page at index page and fails on an error.
func (rig *imagesRig) image(page int) PageImage {
	rig.t.Helper()
	img, err := rig.images.Image(context.Background(), rig.uuid(), page)
	if err != nil {
		rig.t.Fatalf("Image(%d): %v", page, err)
	}
	return img
}

// pageImages are the page images in the container's directory, sorted.
func (rig *imagesRig) pageImages() []string {
	rig.t.Helper()
	dir, _ := rig.st.DocDirByUUID(rig.uuid())
	entries, err := os.ReadDir(dir)
	if err != nil {
		rig.t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "page-") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// owned are the page images the container owns as a fresh store reads it, and as the running
// store's index holds it, which must agree.
func (rig *imagesRig) owned() []string {
	rig.t.Helper()
	var lists [2][]string
	for i, containers := range [...]interface {
		Load(string) (*domain.BlockContainer, error)
	}{rig.containers, reopen(rig.t, rig.st)} {
		c, err := containers.Load(rig.uuid())
		if err != nil {
			rig.t.Fatal(err)
		}
		for _, a := range c.Assets() {
			if strings.HasPrefix(a.Key(), "page-") {
				lists[i] = append(lists[i], a.Key())
			}
		}
		sort.Strings(lists[i])
	}
	if strings.Join(lists[0], " ") != strings.Join(lists[1], " ") {
		rig.t.Errorf("the running store owns %v, the disk %v", lists[0], lists[1])
	}
	return lists[1]
}

// imageName is the asset an image of page p at key is kept as.
func imageName(p link.ID, key string) string { return "page-" + p.String() + "-" + key + ".png" }

// A page is drawn once for its key and kept beside the log as page-{page}-{key}.png: asking again,
// even of a Sieve started again, draws nothing. The drawer is given the page whole, and keeping the
// image moves neither the block's version nor the log.
func TestPageImages_DrawsAPageOnceAndKeepsItBesideTheLog(t *testing.T) {
	rig := newImagesRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsUnbounded), strokeAdd(page(1), stroke(1)))
	if err := rig.replica.Flush(); err != nil {
		t.Fatal(err)
	}
	before := rig.container()
	log := rig.asset(before, StrokesKey)

	first := rig.image(0)
	note := ReadStrokeBasedNote(rig.uuid(), log)
	key, _ := note.PageKey(0)
	export, _ := note.ExportPage(0)
	drawn := rig.drawer.drawings()
	if len(drawn) != 1 || drawn[0].Container != rig.uuid() || drawn[0].Page != page(1) || drawn[0].Key != key ||
		drawn[0].Bounds != link.BoundsFixed || !bytes.Equal(drawn[0].Export, export) {
		t.Fatalf("drawn %+v, want page 1 at %s", drawn, key)
	}
	if first.Key != key || first.Address.String() != "sieve://"+rig.uuid()+"/"+imageName(page(1), key) {
		t.Errorf("image %s at %s", first.Address, first.Key)
	}
	if got := rig.asset(before, imageName(page(1), key)); !bytes.Equal(got, first.Asset.Body()) || !bytes.HasPrefix(got, pngSignature) {
		t.Errorf("kept %q", got)
	}

	if again := rig.image(0); again.Key != key || len(rig.drawer.drawings()) != 1 {
		t.Errorf("asked again: %s, %d drawings", again.Key, len(rig.drawer.drawings()))
	}
	restarted := NewPageImages(NewInkService(nil, reopen(t, rig.st), nil, nil), rig.drawer)
	if img, err := restarted.Image(context.Background(), rig.uuid(), 0); err != nil || img.Key != key || len(rig.drawer.drawings()) != 1 {
		t.Errorf("after a restart: %v, %v, %d drawings", img.Key, err, len(rig.drawer.drawings()))
	}
	if second := rig.image(1); len(rig.drawer.drawings()) != 2 || rig.drawer.drawings()[1].Bounds != link.BoundsUnbounded {
		t.Errorf("page 2: %s, %+v", second.Key, rig.drawer.drawings())
	}

	after := rig.container()
	if after.Version() != before.Version() || !bytes.Equal(rig.asset(after, StrokesKey), log) {
		t.Errorf("version %d → %d, log changed: %v", before.Version(), after.Version(), !bytes.Equal(rig.asset(after, StrokesKey), log))
	}
}

// A page that changed is drawn again, and its image of the earlier key is removed while another
// page's image is kept. A replica appending meanwhile, and saving its block through the container
// it holds, loses neither the log nor an image, before, during or after a drawing.
func TestPageImages_ANewKeyReplacesThePagesImageBesideAnAppendingReplica(t *testing.T) {
	rig := newImagesRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	old, other := rig.image(0), rig.image(1)

	rig.append(strokeAdd(page(1), stroke(2)))
	changed := rig.image(0)
	if changed.Key == old.Key || len(rig.drawer.drawings()) != 3 {
		t.Fatalf("a stroke still queued was not drawn: %s, %d drawings", changed.Key, len(rig.drawer.drawings()))
	}
	want := []string{imageName(page(1), changed.Key), imageName(page(2), other.Key)}
	sort.Strings(want)
	if got := rig.pageImages(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("on disk %v, want %v", got, want)
	}

	rig.append(pageTemplate(page(2), dots))
	if got := rig.owned(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("after the replica saved its block: owned %v, want %v", got, want)
	}

	rig.drawer.mu.Lock()
	rig.drawer.during = func() { rig.append(strokeAdd(page(1), stroke(3)), pageTemplate(page(1), dots)) }
	rig.drawer.mu.Unlock()
	rig.append(strokeRemove(page(1), stroke(2)))
	stale := rig.image(0)
	rig.drawer.mu.Lock()
	rig.drawer.during = nil
	rig.drawer.mu.Unlock()
	stillWanted := append([]string{imageName(page(1), stale.Key)}, want...)
	sort.Strings(stillWanted)
	if got := rig.owned(); strings.Join(got, " ") != strings.Join(stillWanted, " ") {
		t.Errorf("a page that changed while it was drawn: owned %v, want %v — nothing removed", got, stillWanted)
	}
	latest := rig.image(0)
	final := []string{imageName(page(1), latest.Key), imageName(page(2), other.Key)}
	sort.Strings(final)
	if got := rig.owned(); strings.Join(got, " ") != strings.Join(final, " ") {
		t.Errorf("drawn at its key again: owned %v, want %v", got, final)
	}

	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	rig.expectHeld(rig.appended)
	if a, err := rig.containers.LoadAsset(rig.container(), imageName(page(1), latest.Key)); err != nil || !bytes.HasPrefix(a.Body(), pngSignature) {
		t.Errorf("the image after the session: %v", err)
	}
}

// Requests for one page at one key wait on one drawing; one that gives up leaves the drawing to
// the others.
func TestPageImages_ConcurrentRequestsShareOneDrawing(t *testing.T) {
	rig := newImagesRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed), strokeAdd(page(1), stroke(1)))
	rig.drawer.hold = make(chan struct{})
	gaveUp, giveUp := context.WithCancel(context.Background())
	quit := make(chan error, 1)
	go func() {
		_, err := rig.images.Image(gaveUp, rig.uuid(), 0)
		quit <- err
	}()
	keys := make(chan string, 6)
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			img, err := rig.images.Image(context.Background(), rig.uuid(), 0)
			if err != nil {
				t.Error(err)
			}
			keys <- img.Key
		}()
	}
	waitFor(t, func() bool { return len(rig.drawer.drawings()) == 1 })
	giveUp()
	if err := <-quit; !errors.Is(err, context.Canceled) {
		t.Errorf("the request that gave up: %v", err)
	}
	close(rig.drawer.hold)
	wg.Wait()
	close(keys)
	for key := range keys {
		if key != rig.drawer.drawings()[0].Key {
			t.Errorf("key %s", key)
		}
	}
	if n := len(rig.drawer.drawings()); n != 1 {
		t.Errorf("%d drawings", n)
	}
}

// What stops a page being drawn reaches the caller, and nothing is kept.
func TestPageImages_FailuresSurfaceAndKeepNothing(t *testing.T) {
	boom := errors.New("the canvas would not encode")
	for _, tc := range []struct {
		name   string
		drawer func(*fakeDrawer) PageDrawer
		uuid   func(*imagesRig) string
		page   int
		want   error
	}{
		{"no drawer", func(*fakeDrawer) PageDrawer { return nil }, nil, 0, ErrNoDrawer},
		{"nothing connected", func(d *fakeDrawer) PageDrawer { d.err = errors.Join(ErrNoDrawer, boom); return d }, nil, 0, ErrNoDrawer},
		{"a drawing that failed", func(d *fakeDrawer) PageDrawer { d.err = boom; return d }, nil, 0, boom},
		{"an answer that is not a PNG", func(d *fakeDrawer) PageDrawer { d.notPNG = true; return d }, nil, 0, nil},
		{"a page out of range", func(d *fakeDrawer) PageDrawer { return d }, nil, 1, ErrNoSuchPage},
		{"no such note", func(d *fakeDrawer) PageDrawer { return d },
			func(*imagesRig) string { return "0199aaaa-0000-7000-8000-000000000000" }, 0, ErrNoSuchPage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newImagesRig(t, header("Ideas"), pageAdd(page(1), 0, nil, link.BoundsFixed))
			images := NewPageImages(rig.svc, tc.drawer(rig.drawer))
			uuid := rig.uuid()
			if tc.uuid != nil {
				uuid = tc.uuid(rig)
			}
			_, err := images.Image(context.Background(), uuid, tc.page)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Errorf("error %v, want %v", err, tc.want)
			}
			if got := rig.pageImages(); len(got) != 0 {
				t.Errorf("kept %v", got)
			}
		})
	}
}
