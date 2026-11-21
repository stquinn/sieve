package ink

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"

	"sieve/sieve/domain"
)

// Diary is one device's diary: the diary chunks held that were written on that device, oldest
// first, by period and then by their note-headers' created time. It is derived from the notes held
// and never stored.
type Diary struct {
	DeviceID string
	// Device is the device's name, as its newest chunk that names it gives it.
	Device string
	Chunks []SyncedNote
}

// DiaryChunk is whether the note is a chunk of its device's diary: its type is diary.
func (n SyncedNote) DiaryChunk() bool { return n.Type == diaryType }

// diaryCompare orders two diary chunks: by period, then by their note-headers' created time, then
// by uuid.
func (n SyncedNote) diaryCompare(o SyncedNote) int {
	return cmp.Or(strings.Compare(n.Period, o.Period), n.Created.Compare(o.Created), strings.Compare(n.UUID, o.UUID))
}

// Diaries are the diaries among the notes held, one per device a chunk was written on, ordered by
// the device's name and then its id.
func (st Status) Diaries() []Diary {
	byDevice := map[string]int{}
	var diaries []Diary
	for _, n := range st.Notes {
		if !n.DiaryChunk() {
			continue
		}
		i, ok := byDevice[n.DeviceID]
		if !ok {
			i = len(diaries)
			byDevice[n.DeviceID] = i
			diaries = append(diaries, Diary{DeviceID: n.DeviceID})
		}
		diaries[i].Chunks = append(diaries[i].Chunks, n)
	}
	for i := range diaries {
		d := &diaries[i]
		slices.SortFunc(d.Chunks, SyncedNote.diaryCompare)
		for _, c := range d.Chunks {
			if c.Device != "" {
				d.Device = c.Device
			}
		}
	}
	slices.SortFunc(diaries, func(a, b Diary) int {
		return cmp.Or(strings.Compare(a.Device, b.Device), strings.Compare(a.DeviceID, b.DeviceID))
	})
	return diaries
}

// Diary is the diary of the device deviceID, or for "" the diary whose newest chunk is the newest
// held; false when there is no such diary.
func (st Status) Diary(deviceID string) (Diary, bool) {
	var found Diary
	ok := false
	for _, d := range st.Diaries() {
		switch {
		case deviceID != "" && d.DeviceID == deviceID:
			return d, true
		case deviceID == "" && (!ok || found.newest().diaryCompare(d.newest()) < 0):
			found, ok = d, true
		}
	}
	return found, ok
}

// newest is the diary's newest chunk; the zero SyncedNote when it has none.
func (d Diary) newest() SyncedNote {
	if len(d.Chunks) == 0 {
		return SyncedNote{}
	}
	return d.Chunks[len(d.Chunks)-1]
}

// Chunk is the chunk the diary opens at on day: its newest chunk whose period is day's month,
// else its newest chunk; false when it has none.
func (d Diary) Chunk(day time.Time) (SyncedNote, bool) {
	month := day.Format("2006-01")
	for i := len(d.Chunks) - 1; i >= 0; i-- {
		if d.Chunks[i].Period == month {
			return d.Chunks[i], true
		}
	}
	return d.newest(), len(d.Chunks) > 0
}

// DiaryOn is where d opens on day, in day's own zone: its Chunk for day, at the last of its pages
// named day's date (YYYY-MM-DD), else at its last page; the chunk alone when it has no pages. A
// diary with no chunks is ErrNoSuchPage.
func (s *InkService) DiaryOn(d Diary, day time.Time) (domain.Address, error) {
	chunk, ok := d.Chunk(day)
	if !ok {
		return domain.Address{}, fmt.Errorf("%w: the diary of %q holds no chunk", ErrNoSuchPage, d.DeviceID)
	}
	page := NewDigitalNoteKind().pageFor(s.noteAttrs(chunk.UUID), day.Format(time.DateOnly))
	if page == "" {
		return domain.NewContainerAddress(chunk.UUID), nil
	}
	return domain.NewLeafAddress(chunk.UUID, page), nil
}
