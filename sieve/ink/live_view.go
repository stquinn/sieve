package ink

import (
	"fmt"
	"sync"
	"time"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// KindLive is the container kind of the Live view.
const KindLive = "ink-live"

// LiveGrace is how long the Live view outlasts the last live note.
const LiveGrace = 30 * time.Second

// LiveStatus is the Live view as the sidebar shows it. The zero LiveStatus is no Live view.
type LiveStatus struct {
	// Present is whether the Live view exists.
	Present bool
	UUID    string
	// Device is the name of the device the mirrored note is written on, "" when it is not known.
	Device string
	// Note is the uuid of the container holding the mirrored note, "" before one holds it.
	Note string
	// NoteTitle is what the mirrored note is called (DigitalNoteKind.Name).
	NoteTitle string
	// Waiting is the tablet not live, within LiveGrace of the last live note.
	Waiting bool
}

// LiveView is the tablet's live view as a container of its own: the note the tablet is writing,
// the page it is written on, and whether the tablet is live or the view is waiting for it. It
// exists from the first live note until LiveGrace after the last; a note live again within the
// grace keeps it. Its uuid is minted when the view is built and is never stored, so it names
// nothing after the run that minted it.
//
// It is the Router's source for that uuid: Resolve answers, only while the view exists, a node
// of kind KindLive whose attrs are id, title, live (container, title, page, waiting) and the
// mirrored note's note and note_device attrs in the digital-note block's shape. Every change to
// them is told to the change listener; when the view ends, every session tab of it is closed and
// the invalidator is told the container is deleted. It is safe for concurrent use.
type LiveView struct {
	uuid string
	svc  *InkService
	// afterFunc calls f once d has passed, unless the stop it returns is called first.
	afterFunc func(d time.Duration, f func()) (stop func() bool)
	grace     time.Duration

	mu       sync.Mutex
	listener services.ContainerChangeListener
	present  bool
	waiting  bool
	// live is the note mirrored: the live one, or while waiting the last one live.
	live LiveNote
	// ending stops the grace's timer; epoch numbers the grace, so a timer that fires after it was
	// stopped ends nothing.
	ending func() bool
	epoch  uint64
}

// newLiveView is the Live view of svc, under a fresh uuid.
func newLiveView(svc *InkService) *LiveView {
	return &LiveView{
		uuid: ident.New(), svc: svc, grace: LiveGrace,
		afterFunc: func(d time.Duration, f func()) func() bool { return time.AfterFunc(d, f).Stop },
	}
}

// UUID is the Live view's uuid.
func (v *LiveView) UUID() string { return v.uuid }

// Name identifies this source in Router diagnostics.
func (v *LiveView) Name() string { return KindLive }

// Search offers the view, while it exists, to a search matching its name that admits kind
// KindLive and what is not durable, under its address and the title Resolve gives it; anything
// else offers nothing. The view has no folder.
func (v *LiveView) Search(c domain.SearchCriteria) []domain.Candidate {
	if !c.Fields.Has(domain.SearchName) || !c.Includes(KindLive, false) || !c.InFolder("") {
		return nil
	}
	v.mu.Lock()
	present, live, waiting := v.present, v.live, v.waiting
	v.mu.Unlock()
	if !present {
		return nil
	}
	title := v.attrs(live, waiting)["title"].(string)
	matched, ok := c.Match(map[domain.SearchField][]string{domain.SearchName: {title}})
	if !ok {
		return nil
	}
	return []domain.Candidate{{URI: domain.NewContainerAddress(v.uuid).String(), Title: title, Kind: KindLive, Matched: matched}}
}

// Claims is addr naming the view's uuid, which no store holds.
func (v *LiveView) Claims(addr domain.Address) bool { return addr.Container == v.uuid }

// Resolve answers the view's own uuid at container grain while the view exists; anything else is
// domain.ErrNodeNotFound.
func (v *LiveView) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	v.mu.Lock()
	present, live, waiting := v.present, v.live, v.waiting
	v.mu.Unlock()
	if addr.Container != v.uuid || !addr.IsContainer() || addr.IsPinned() || !present {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s is no Live view", domain.ErrNodeNotFound, addr.String())
	}
	attrs := v.attrs(live, waiting)
	return domain.NodeDescriptor{URI: addr.String(), ID: v.uuid, Kind: KindLive, Title: attrs["title"].(string), Attrs: attrs}, nil
}

// Mirrors is the container of the note the view mirrors, "" before one holds it, and whether the
// view exists.
func (v *LiveView) Mirrors() (container string, present bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.live.Container, v.present
}

// Status is the view as the sidebar shows it.
func (v *LiveView) Status() LiveStatus {
	v.mu.Lock()
	present, live, waiting := v.present, v.live, v.waiting
	v.mu.Unlock()
	if !present {
		return LiveStatus{}
	}
	note := v.svc.noteAttrs(live.Container)
	return LiveStatus{Present: true, UUID: v.uuid, Device: v.deviceOf(note), Note: live.Container,
		NoteTitle: v.svc.noteName(live.Container), Waiting: waiting}
}

// setListener registers who is told the view's node changed.
func (v *LiveView) setListener(l services.ContainerChangeListener) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.listener = l
}

// follow is the tablet showing live as live, or none. A live note makes the view exist and ends
// any wait; none starts the grace, at whose end the view ends.
func (v *LiveView) follow(live LiveNote) {
	v.mu.Lock()
	if live.Note != (link.ID{}) {
		was := v.present && !v.waiting
		changed := !was || v.live != live
		retitled := !was || v.live.Container != live.Container
		v.stopGrace()
		v.present, v.waiting, v.live = true, false, live
		v.mu.Unlock()
		if changed {
			v.changed()
		}
		if retitled {
			v.svc.invalidate()
		}
		return
	}
	if !v.present || v.waiting {
		v.mu.Unlock()
		return
	}
	v.waiting = true
	v.epoch++
	epoch := v.epoch
	v.ending = v.afterFunc(v.grace, func() { v.end(epoch) })
	v.mu.Unlock()
	v.changed()
	v.svc.invalidate()
}

// noteChanged is the note in container having changed: its title, its name, its pages.
func (v *LiveView) noteChanged(container string) {
	v.mu.Lock()
	mirrored := v.present && container != "" && v.live.Container == container
	v.mu.Unlock()
	if mirrored {
		v.changed()
	}
}

// end is the grace numbered epoch over: the view ends unless a live note came since. Every session
// tab of it is closed, the change listener finds it gone, and the container is told deleted.
func (v *LiveView) end(epoch uint64) {
	v.mu.Lock()
	if !v.present || !v.waiting || v.epoch != epoch {
		v.mu.Unlock()
		return
	}
	v.present, v.waiting, v.live, v.ending = false, false, LiveNote{}, nil
	v.mu.Unlock()
	v.svc.liveEnded(v.uuid)
	v.changed()
	if v.svc.invalidator != nil {
		v.svc.invalidator.ContainerDeleted(v.uuid)
		v.svc.invalidator.SessionChanged()
	}
	v.svc.invalidate()
}

// stopGrace stops a running grace. v.mu is held.
func (v *LiveView) stopGrace() {
	if v.ending != nil {
		v.ending()
		v.ending = nil
	}
	v.epoch++
}

// changed tells the change listener the view's node changed.
func (v *LiveView) changed() {
	v.mu.Lock()
	l := v.listener
	v.mu.Unlock()
	if l == nil {
		return
	}
	if err := l.Refresh(v.uuid); err != nil {
		logger.Warn("ink: refreshing the Live view", "err", err.Error())
	}
}

// attrs are the node's attrs with live mirrored.
func (v *LiveView) attrs(live LiveNote, waiting bool) map[string]interface{} {
	note := v.svc.noteAttrs(live.Container)
	title := "Live"
	if device := v.deviceOf(note); device != "" {
		title += " · " + device
	}
	page := ""
	if live.Page != (link.ID{}) {
		page = live.Page.String()
	}
	attrs := map[string]interface{}{
		"id":    v.uuid,
		"title": title,
		"live": map[string]interface{}{
			"container": live.Container, "title": v.svc.noteName(live.Container), "page": page, "waiting": waiting,
		},
		"note":        map[string]interface{}{},
		"note_device": map[string]interface{}{},
	}
	for _, key := range []string{"note", "note_device"} {
		if value, ok := note[key]; ok && value != nil {
			attrs[key] = value
		}
	}
	return attrs
}

// deviceOf is the device name a note's attrs give, "" when they give none.
func (v *LiveView) deviceOf(note map[string]interface{}) string {
	device, _ := note["note_device"].(map[string]interface{})
	name, _ := device["name"].(string)
	return name
}
