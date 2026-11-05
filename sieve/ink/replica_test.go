package ink

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

var linkKey = link.Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}

// quietObserver hears a session and keeps nothing.
type quietObserver struct{}

func (quietObserver) Notes([]link.NoteEntry)         {}
func (quietObserver) Opened(link.ID, uint32, uint32) {}
func (quietObserver) Committed(link.ID, link.Record) {}
func (quietObserver) Done(link.ID, uint32, int)      {}
func (quietObserver) Live(link.ID, link.ID)          {}
func (quietObserver) Ink([]link.LiveRecord)          {}
func (quietObserver) Refused(link.ID, string)        {}

// replicaRig is one Sieve's store and one companion serving noteID, synced by real sessions.
type replicaRig struct {
	t          *testing.T
	st         *filestore.FileStore
	containers *services.BlockContainerService
	companion  *link.ScriptedCompanion
	replicas   *NoteReplicas
}

func newReplicaRig(t *testing.T, records []link.Record) *replicaRig {
	containers, st := newTestContainers(t)
	rig := &replicaRig{t: t, st: st, containers: containers,
		companion: link.NewScriptedCompanion(linkKey, noteID, page(1), records)}
	rig.restart()
	return rig
}

// restart is the Sieve starting again: a fresh store over the same disk, and fresh replicas.
func (rig *replicaRig) restart() {
	rig.containers = reopen(rig.t, rig.st)
	rig.replicas = NewNoteReplicas(rig.containers, companionID)
}

// sync runs one catch-up session to its end, then ends the replicas' session.
func (rig *replicaRig) sync() error {
	rig.t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		rig.t.Fatal(err)
	}
	defer listener.Close()
	ours, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		rig.t.Fatal(err)
	}
	defer ours.Close()
	theirs, err := listener.Accept()
	if err != nil {
		rig.t.Fatal(err)
	}
	go func() {
		_ = rig.companion.Serve(theirs)
		theirs.Close()
	}()
	done := make(chan error, 1)
	go func() {
		done <- link.NewSession(ours, linkKey, rig.replicas, quietObserver{}, link.Plan{CatchUp: true}).Run()
	}()
	select {
	case err = <-done:
	case <-time.After(5 * time.Second):
		rig.t.Fatal("the session did not finish")
	}
	if endErr := rig.replicas.End(); endErr != nil {
		rig.t.Fatalf("End: %v", endErr)
	}
	return err
}

// opens is every OPEN's haveSeq since it was last asked.
func (rig *replicaRig) opens() []uint32 {
	var out []uint32
	for {
		select {
		case have := <-rig.companion.Opens:
			out = append(out, have)
		default:
			return out
		}
	}
}

// container is the one container holding noteID, or nil.
func (rig *replicaRig) container() *domain.BlockContainer {
	rig.t.Helper()
	found, err := reopen(rig.t, rig.st).Find(KindDigitalNote, map[string]string{"note_source_id": noteID.String()})
	if err != nil || len(found) > 1 {
		rig.t.Fatalf("found %v, %v", found, err)
	}
	for uuid := range found {
		c, err := reopen(rig.t, rig.st).Load(uuid)
		if err != nil {
			rig.t.Fatal(err)
		}
		return c
	}
	return nil
}

// dir is a container's directory.
func (rig *replicaRig) dir(c *domain.BlockContainer) string {
	return filepath.Join(rig.st.Root(), "testhost", domain.Blocks.Key, c.UUID())
}

// asset reads an asset of c from disk.
func (rig *replicaRig) asset(c *domain.BlockContainer, key string) []byte {
	rig.t.Helper()
	raw, err := os.ReadFile(filepath.Join(rig.dir(c), key))
	if err != nil {
		rig.t.Fatal(err)
	}
	return raw
}

// assetOrNil reads an asset of c from disk, nil while there is none.
func (rig *replicaRig) assetOrNil(c *domain.BlockContainer, key string) []byte {
	raw, _ := os.ReadFile(filepath.Join(rig.dir(c), key))
	return raw
}

// expectHeld checks that the container holds exactly records: every line re-parses, their chain
// is the companion's, and the block's synced seq and face agree with them.
func (rig *replicaRig) expectHeld(records []link.Record) *domain.BlockContainer {
	rig.t.Helper()
	c := rig.container()
	if c == nil {
		rig.t.Fatal("no container")
	}
	raw := rig.asset(c, StrokesKey)
	lines := strings.SplitAfter(string(raw), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	var held []link.Record
	for i, line := range lines {
		r, err := link.ParseJSONLine([]byte(line))
		if err != nil {
			rig.t.Fatalf("line %d: %v", i+1, err)
		}
		held = append(held, r)
	}
	if len(held) != len(records) || chainOf(rig.t, held) != chainOf(rig.t, records) {
		rig.t.Errorf("holds %d records whose chain is not the companion's %d", len(held), len(records))
	}
	if got := c.Block().Attrs["note_synced_seq"]; got != len(records) {
		rig.t.Errorf("note_synced_seq = %v, want %d", got, len(records))
	}
	if got := c.Storable().Meta()["note_synced_seq"]; got != strconv.Itoa(len(records)) {
		rig.t.Errorf("face note_synced_seq = %q", got)
	}
	return c
}

func TestReplica_FullCatchUpCreatesTheNoteAndHoldsTheCompanionsLog(t *testing.T) {
	records := logOf(header("Ideas"), pageAdd(page(1), 0, ruled, link.BoundsFixed), strokeAdd(page(1), stroke(1)),
		pageAdd(page(2), 1, nil, link.BoundsFixed), strokeAdd(page(2), stroke(2), offSheet), strokeRemove(page(1), stroke(1)))
	rig := newReplicaRig(t, records)
	if _, err := rig.replicas.Open(noteID); err != nil || rig.container() != nil {
		t.Fatalf("opening an unknown note: %v, or it created a container", err)
	}
	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	c := rig.expectHeld(records)
	if c.Block().StringAttr("title") != "Ideas" || c.Storable().Meta()["note_pages"] != "2" || c.Block().ID != c.UUID() {
		t.Errorf("block %v", c.Block().Attrs)
	}
	if c.Block().StringAttr("note_source_id") != noteID.String() || c.Block().StringAttr("note_companion") != companionID {
		t.Errorf("provenance %v", c.Block().Attrs)
	}
	if v := c.Versions(); len(v) != 1 {
		t.Errorf("%d versions after one session", len(v))
	}
	note := ReadStrokeBasedNote(c.UUID(), rig.asset(c, StrokesKey))
	if note.PageCount() != 2 || len(note.Strokes(0)) != 0 || len(note.Strokes(1)) != 1 {
		t.Errorf("replayed %s", shape(note))
	}
}

func TestReplica_ResumesFromWhatTheAssetHolds(t *testing.T) {
	records := strokesLog(6)
	for _, tc := range []struct {
		name string
		// interrupt leaves the Sieve holding part of the log, as a crash or a dropped link does.
		interrupt func(rig *replicaRig)
		want      []uint32
	}{
		{"after a dropped session", func(rig *replicaRig) {
			rig.companion.GapAt = 4
			if err := rig.sync(); err == nil {
				t.Fatal("a gap was taken")
			}
			rig.companion.GapAt = 0
			rig.expectHeld(records[:3])
		}, []uint32{0, 3}},
		{"with the asset ahead of the block", func(rig *replicaRig) {
			rig.companion.SetRecords(records[:3])
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			c := rig.container()
			if _, err := rig.containers.AppendAsset(c, StrokesKey, jsonlOf(t, records[3:5])); err != nil {
				t.Fatal(err)
			}
			rig.companion.SetRecords(records)
		}, []uint32{0, 5}},
		{"with a damaged tail", func(rig *replicaRig) {
			rig.companion.SetRecords(records[:5])
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			c := rig.container()
			raw := rig.asset(c, StrokesKey)
			cut := len(jsonlOf(t, records[:3]))
			damaged := append(append([]byte(nil), raw[:cut]...), bytes.Replace(raw[cut:], []byte(`"seq":4`), []byte(`"seq":9`), 1)...)
			if err := os.WriteFile(filepath.Join(rig.dir(c), StrokesKey), damaged, 0o644); err != nil {
				t.Fatal(err)
			}
			rig.companion.SetRecords(records)
		}, []uint32{0, 3}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReplicaRig(t, records)
			tc.interrupt(rig)
			rig.restart()
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			if got := rig.opens(); len(got) != len(tc.want) || got[0] != tc.want[0] || got[1] != tc.want[1] {
				t.Errorf("OPENs asked from %v, want %v", got, tc.want)
			}
			rig.expectHeld(records)
		})
	}
}

func TestReplica_ALogTheCompanionDisownsIsSetAsideAndReplayed(t *testing.T) {
	records := strokesLog(4)
	for _, tc := range []struct {
		name  string
		setup func(*link.ScriptedCompanion)
		// aside is how many records the log held when it was set aside.
		aside int
	}{
		{"a HEAD whose chain differs", func(c *link.ScriptedCompanion) { c.CorruptHead = true }, len(records)},
		{"REFUSE ahead", func(c *link.ScriptedCompanion) { c.RefuseAhead = true }, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReplicaRig(t, records[:2])
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			first := rig.container()
			rig.companion.SetRecords(records)
			tc.setup(rig.companion)
			rig.restart()
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			if got := rig.opens(); len(got) != 3 || got[1] != 2 || got[2] != 0 {
				t.Errorf("OPENs asked from %v, want 0, 2, 0", got)
			}
			c := rig.expectHeld(records)
			if c.UUID() != first.UUID() {
				t.Errorf("set aside into a new container %s", c.UUID())
			}
			if aside := rig.asset(c, "strokes.aside-1.jsonl"); !bytes.Equal(aside, jsonlOf(t, records[:tc.aside])) {
				t.Errorf("aside asset holds %q", aside)
			}
		})
	}
}

// A session saves a changed note's block once, however many records it takes; a session that
// changes nothing saves nothing, and one that skips a note never replays its asset.
func TestReplica_SavesOncePerSessionAndSkipsWhatIsHeld(t *testing.T) {
	records := strokesLog(300)
	rig := newReplicaRig(t, records[:200])
	rig.replicas.flushBytes = 4 << 10
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	rig.expectHeld(records[:200])
	rig.companion.SetRecords(records)
	rig.restart()
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	c := rig.expectHeld(records)
	if v := c.Versions(); len(v) != 2 {
		t.Errorf("%d versions after two sessions", len(v))
	}

	// A broken asset a replay would cut: skipping the note must leave it as it is.
	broken := append(rig.asset(c, StrokesKey), "{not a record"...)
	if err := os.WriteFile(filepath.Join(rig.dir(c), StrokesKey), broken, 0o644); err != nil {
		t.Fatal(err)
	}
	rig.restart()
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	if got := rig.opens(); len(got) != 2 {
		t.Errorf("OPENs %v: a held note was opened", got)
	}
	if !bytes.Equal(rig.asset(c, StrokesKey), broken) {
		t.Error("a skipped note's asset was replayed")
	}
	if _, err := rig.replicas.Open(noteID); err != nil {
		t.Fatal(err)
	}
	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	if v := rig.container().Versions(); len(v) != 2 {
		t.Errorf("an unchanged note was saved: %d versions", len(v))
	}
}

// Queued lines reach the asset on the timer alone, and a failed write is reported by the next
// Append and Flush rather than lost.
func TestReplica_WritesOnTheTimerAndReportsAFailedWrite(t *testing.T) {
	records := strokesLog(3)
	rig := newReplicaRig(t, records)
	rig.replicas.flushAfter = 10 * time.Millisecond
	opened, err := rig.replicas.Open(noteID)
	if err != nil {
		t.Fatal(err)
	}
	r := opened.(*NoteReplica)
	appendRecord := func(rec link.Record) error {
		body, err := rec.Body()
		if err != nil {
			t.Fatal(err)
		}
		return r.Append(rec, body)
	}
	if err := appendRecord(records[0]); err != nil {
		t.Fatal(err)
	}
	if err := appendRecord(records[2]); err == nil || r.Cursor().Seq != 1 {
		t.Errorf("a record out of order was taken: %v at %d", err, r.Cursor().Seq)
	}
	c, err := rig.containers.Load(r.UUID())
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !bytes.Equal(rig.assetOrNil(c, StrokesKey), jsonlOf(t, records[:1])) {
		if time.Now().After(deadline) {
			t.Fatal("the timer did not write the queue")
		}
		time.Sleep(5 * time.Millisecond)
	}

	if err := os.RemoveAll(rig.dir(c)); err != nil {
		t.Fatal(err)
	}
	if err := appendRecord(records[1]); err != nil {
		t.Fatal(err)
	}
	if err := r.Flush(); err == nil {
		t.Fatal("a failed write was not reported")
	}
	if err := appendRecord(records[2]); err == nil {
		t.Error("an Append after a failed write was taken")
	}
	if err := rig.replicas.End(); err == nil {
		t.Error("End hid a failed write")
	}
}
