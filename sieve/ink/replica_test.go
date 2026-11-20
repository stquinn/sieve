package ink

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// catchUpObserver hears a session and keeps nothing but, when committed is set, calls it at each
// record committed.
type catchUpObserver struct {
	committed func(link.Record)
}

func (catchUpObserver) Notes([]link.NoteEntry)         {}
func (catchUpObserver) Opened(link.ID, uint32, uint32) {}
func (o catchUpObserver) Committed(_ link.ID, rec link.Record) {
	if o.committed != nil {
		o.committed(rec)
	}
}
func (catchUpObserver) Done(link.ID, uint32, int) {}
func (catchUpObserver) Live(link.ID, link.ID)     {}
func (catchUpObserver) Ink([]link.LiveRecord)     {}
func (catchUpObserver) Refused(link.ID, string)   {}
func (catchUpObserver) Rewound(link.ID, uint32)   {}

// replicaRig is one Sieve's store and one companion serving noteID, synced by real sessions.
type replicaRig struct {
	t          *testing.T
	st         *filestore.FileStore
	containers *services.BlockContainerService
	companion  *link.ScriptedCompanion
	replicas   *NoteReplicas
	// staging outlives a restart, as the machine's temporary directory does.
	staging *NoteStaging
}

func newReplicaRig(t *testing.T, records []link.Record) *replicaRig {
	containers, st := newTestContainers(t)
	rig := &replicaRig{t: t, st: st, containers: containers, staging: NewNoteStaging(t.TempDir()),
		companion: link.NewScriptedCompanion(linkKey, noteID, page(1), records)}
	rig.restart()
	return rig
}

// restart is the Sieve starting again: a fresh store over the same disk, and fresh replicas.
func (rig *replicaRig) restart() {
	rig.containers = reopen(rig.t, rig.st)
	rig.replicas = NewNoteReplicas(rig.containers, rig.staging, companionID)
}

// sync runs one catch-up session to its end, then ends the replicas' session.
func (rig *replicaRig) sync() error {
	rig.t.Helper()
	return rig.syncHeard(catchUpObserver{})
}

// syncHeard is sync heard by obs.
func (rig *replicaRig) syncHeard(obs catchUpObserver) error {
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
		done <- link.NewSession(ours, linkKey, rig.replicas, obs, link.Plan{CatchUp: true}).Run()
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
	dir, _ := rig.st.DocDirByUUID(c.UUID())
	return dir
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

// logDamage is what a sync agent can leave of a published log of strokesLog(6)'s first six
// records: the bytes it leaves, and the seq of the last record they still replay to.
type logDamage struct {
	name   string
	damage func(t *testing.T, published []link.Record) []byte
	good   uint32
}

var logDamages = []logDamage{
	{"lines removed from the middle", func(t *testing.T, p []link.Record) []byte {
		return append(jsonlOf(t, p[:2]), jsonlOf(t, p[4:])...)
	}, 2},
	{"the tail cut", func(t *testing.T, p []link.Record) []byte {
		b := jsonlOf(t, p)
		return b[:len(b)-10]
	}, 5},
}

// writeLog replaces the published log of c on disk with raw, under every replica.
func (rig *replicaRig) writeLog(c *domain.BlockContainer, raw []byte) {
	rig.t.Helper()
	if err := os.WriteFile(filepath.Join(rig.dir(c), StrokesKey), raw, 0o644); err != nil {
		rig.t.Fatal(err)
	}
}

// expectAside checks that c keeps exactly one log aside, holding want.
func (rig *replicaRig) expectAside(c *domain.BlockContainer, want []byte) {
	rig.t.Helper()
	if got := rig.assetOrNil(c, "strokes.aside-1.jsonl"); !bytes.Equal(got, want) {
		rig.t.Errorf("the aside holds %q, want %q", got, want)
	}
	if extra := rig.assetOrNil(c, "strokes.aside-2.jsonl"); extra != nil {
		rig.t.Errorf("a second aside holds %q", extra)
	}
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
	if !bytes.Equal(raw, jsonlOf(rig.t, records)) {
		rig.t.Errorf("the log is not the companion's, byte for byte")
	}
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
		{"after a session dropped mid catch-up", func(rig *replicaRig) {
			rig.companion.GapAt = 4
			if err := rig.sync(); err == nil {
				t.Fatal("a gap was taken")
			}
			rig.companion.GapAt = 0
			if c := rig.container(); rig.assetOrNil(c, StrokesKey) != nil || c.Storable().Meta()["note_synced_seq"] != "0" {
				t.Errorf("a catch-up the link dropped reached the container: face %v", c.Storable().Meta())
			}
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

// A published log damaged under the replica — found when the replica opens it, or by the next
// write following it, whose length is wrong — is rewound to its last good record: the whole
// damaged file is kept aside, the note is asked for from that record, and the log ends as the
// companion's, byte for byte.
func TestReplica_ADamagedLogIsRewoundToItsLastGoodRecordAndRefilled(t *testing.T) {
	records := strokesLog(6)
	published := records[:6]
	for _, d := range logDamages {
		for _, tc := range []struct {
			name string
			// detect damages the log and brings the replica to find it, returning what the aside
			// must hold.
			detect func(t *testing.T, rig *replicaRig) []byte
		}{
			{"on open", func(t *testing.T, rig *replicaRig) []byte {
				damaged := d.damage(t, published)
				rig.writeLog(rig.container(), damaged)
				return damaged
			}},
			{"on the next append", func(t *testing.T, rig *replicaRig) []byte {
				opened, err := rig.replicas.Open(noteID)
				if err != nil {
					t.Fatal(err)
				}
				r := opened.(*NoteReplica)
				rig.replicas.flushBytes, rig.replicas.flushAfter = 1, time.Hour
				damaged := d.damage(t, published)
				rig.writeLog(rig.container(), damaged)
				for i, rec := range records[6:] {
					body, _ := rec.Body()
					err := r.Append(rec, body)
					if i == 0 && err != nil {
						t.Fatal(err)
					}
					if i == 1 && !errors.Is(err, link.ErrRewound) {
						t.Fatalf("the append after the damage: %v", err)
					}
				}
				if got := r.Cursor().Seq; got != d.good {
					t.Errorf("rewound to %d, want %d", got, d.good)
				}
				if err := rig.replicas.End(); err != nil {
					t.Fatal(err)
				}
				return append(damaged, jsonlOf(t, records[6:7])...)
			}},
		} {
			t.Run(d.name+" "+tc.name, func(t *testing.T) {
				rig := newReplicaRig(t, published)
				if err := rig.sync(); err != nil {
					t.Fatal(err)
				}
				rig.opens()
				rig.restart()
				aside := tc.detect(t, rig)
				rig.companion.SetRecords(records)
				rig.restart()
				if err := rig.sync(); err != nil {
					t.Fatal(err)
				}
				if got := rig.opens(); len(got) != 1 || got[0] != d.good {
					t.Errorf("OPENs asked from %v, want %d", got, d.good)
				}
				rig.expectAside(rig.expectHeld(records), aside)
			})
		}
	}
}

// Staged records that do not replay to the cursor the replica was sent to are not published: the
// replica is rewound to its published log, which is kept as it is, and Settle is ErrRewound.
func TestReplica_AStagedCatchUpThatDoesNotReachItsCursorIsRewound(t *testing.T) {
	records := strokesLog(4)
	rig := newReplicaRig(t, records[:3])
	if err := rig.sync(); err != nil {
		t.Fatal(err)
	}
	rig.restart()
	opened, err := rig.replicas.Open(noteID)
	if err != nil {
		t.Fatal(err)
	}
	r := opened.(*NoteReplica)
	if err := r.Begin(uint32(len(records))); err != nil {
		t.Fatal(err)
	}
	for _, rec := range records[3:] {
		body, _ := rec.Body()
		if err := r.Append(rec, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Flush(); err != nil {
		t.Fatal(err)
	}
	uuid := r.UUID()
	if err := os.WriteFile(filepath.Join(rig.staging.dir, uuid+".jsonl"), jsonlOf(t, records[3:4]), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.Settle(); !errors.Is(err, link.ErrRewound) {
		t.Fatalf("Settle: %v", err)
	}
	body, _ := records[3].Body()
	if err := r.Append(records[3], body); !errors.Is(err, link.ErrRewound) || r.Cursor().Seq != 3 {
		t.Errorf("an append to the rewound replica: %v at %d", err, r.Cursor().Seq)
	}
	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	c := rig.expectHeld(records[:3])
	if aside := rig.assetOrNil(c, "strokes.aside-1.jsonl"); aside != nil {
		t.Errorf("a whole published log was kept aside: %q", aside)
	}
}

// A catch-up writes nothing into the container until its DONE, however often its queue is
// written; at the DONE its records are published in one write — the whole log for a note that had
// none, otherwise one append to the same file — and its staged file is dropped.
func TestReplica_ACatchUpIsPublishedWholeAtItsDone(t *testing.T) {
	records := strokesLog(8)
	for _, tc := range []struct {
		name string
		// synced is how many records an earlier session published.
		synced int
	}{
		{"a note's first catch-up", 0},
		{"a catch-up onto a published log", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReplicaRig(t, records[:tc.synced])
			var before os.FileInfo
			if tc.synced > 0 {
				if err := rig.sync(); err != nil {
					t.Fatal(err)
				}
				info, err := os.Stat(filepath.Join(rig.dir(rig.container()), StrokesKey))
				if err != nil {
					t.Fatal(err)
				}
				before = info
				rig.restart()
			}
			rig.companion.SetRecords(records)
			rig.replicas.flushBytes = 1
			var during []string
			err := rig.syncHeard(catchUpObserver{committed: func(rec link.Record) {
				if got := rig.assetOrNil(rig.container(), StrokesKey); !bytes.Equal(got, jsonlOf(t, records[:tc.synced])) {
					during = append(during, fmt.Sprintf("seq %d: %d bytes", rec.Seq, len(got)))
				}
			}})
			if err != nil {
				t.Fatal(err)
			}
			if len(during) > 0 {
				t.Errorf("the container's log moved before the DONE: %v", during)
			}
			c := rig.expectHeld(records)
			after, err := os.Stat(filepath.Join(rig.dir(c), StrokesKey))
			if err != nil {
				t.Fatal(err)
			}
			if before != nil && !os.SameFile(before, after) {
				t.Error("the published log was rewritten, not appended to")
			}
			if staged, _ := os.ReadDir(rig.staging.dir); len(staged) != 0 {
				t.Errorf("staging holds %d files after the publish", len(staged))
			}
		})
	}
}

// A staged catch-up is resumed only where it follows the published log and replays cleanly: one
// complete before the link dropped is published by the next DONE with no record sent, and any
// other staged file is deleted and the note asked for from its published log.
func TestReplica_ResumesAStagedCatchUpOnlyWhereItFollowsThePublishedLog(t *testing.T) {
	records := strokesLog(5)
	all := uint32(len(records))
	for _, tc := range []struct {
		name   string
		staged func(t *testing.T) []byte
		// open is the haveSeq the next session's OPEN asks from.
		open uint32
	}{
		{"the rest of the log, staged whole", func(t *testing.T) []byte { return jsonlOf(t, records[2:]) }, all},
		{"part of the rest", func(t *testing.T) []byte { return jsonlOf(t, records[2:4]) }, 4},
		{"records already published", func(t *testing.T) []byte { return jsonlOf(t, records[:4]) }, 2},
		{"records past a gap", func(t *testing.T) []byte { return jsonlOf(t, records[3:]) }, 2},
		{"a last line cut short", func(t *testing.T) []byte {
			b := jsonlOf(t, records[2:])
			return b[:len(b)-3]
		}, 2},
		{"garbage", func(*testing.T) []byte { return []byte("{not a record\n") }, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReplicaRig(t, records[:2])
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			rig.opens()
			uuid := rig.container().UUID()
			if err := rig.staging.Append(uuid, tc.staged(t)); err != nil {
				t.Fatal(err)
			}
			rig.companion.SetRecords(records)
			rig.restart()
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			if got := rig.opens(); len(got) != 1 || got[0] != tc.open {
				t.Errorf("OPENs asked from %v, want %d", got, tc.open)
			}
			rig.expectHeld(records)
			if _, err := os.Stat(filepath.Join(rig.staging.dir, uuid+".jsonl")); !os.IsNotExist(err) {
				t.Errorf("the staged file outlived the publish: %v", err)
			}
		})
	}
}

// A log whose chain is not the companion's — a line altered, or a HEAD or REFUSE that disowns it —
// is rewound to nothing and synced again whole: what is kept aside is the published log, and the
// records of a catch-up under way are dropped.
func TestReplica_ALogTheCompanionDisownsIsRewoundToNothingAndReplayed(t *testing.T) {
	records := strokesLog(4)
	for _, tc := range []struct {
		name string
		// setup returns what the published log holds once it has done its work.
		setup func(t *testing.T, rig *replicaRig) []byte
	}{
		{"a HEAD whose chain differs", func(t *testing.T, rig *replicaRig) []byte {
			rig.companion.CorruptHead = true
			return jsonlOf(t, records[:2])
		}},
		{"REFUSE ahead", func(t *testing.T, rig *replicaRig) []byte {
			rig.companion.RefuseAhead = true
			return jsonlOf(t, records[:2])
		}},
		{"a line altered", func(t *testing.T, rig *replicaRig) []byte {
			altered := bytes.Replace(jsonlOf(t, records[:2]), []byte(`"Strokes"`), []byte(`"Strokez"`), 1)
			rig.writeLog(rig.container(), altered)
			return altered
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newReplicaRig(t, records[:2])
			if err := rig.sync(); err != nil {
				t.Fatal(err)
			}
			first := rig.container()
			rig.companion.SetRecords(records)
			published := tc.setup(t, rig)
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
			rig.expectAside(c, published)
		})
	}
}

// A catch-up saves a changed note's block once, when the note reaches its head, however many
// records it takes; a session that changes nothing saves nothing, and one that skips a note never
// replays its asset.
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

// The first block of a note already describes its header, and its container holds no log until
// the catch-up settles. Once it has, its block and face equal what the asset holds, with the
// session still open; after that a structural record saves the block at once and a stroke record
// never does, so End saves only what strokes moved. A session's versions are at most one for the
// catch-up, one per structural record after it, and one at End.
func TestReplica_SavesWhenSettledAndOnStructureButNeverPerStroke(t *testing.T) {
	caughtUp := strokesLog(3)
	strokes := func(from, n int) []link.Record {
		var out []link.Record
		for i := 0; i < n; i++ {
			out = append(out, strokeAdd(page(1), stroke(byte(from+i))))
		}
		return out
	}
	for _, tc := range []struct {
		name string
		live []link.Record
		// live and ended are the versions after the live records and after End.
		live1, ended int
	}{
		{"nothing after the catch-up", nil, 1, 1},
		{"a run of strokes", strokes(10, 20), 1, 2},
		{"a page added", []link.Record{pageAdd(page(2), 1, dots, link.BoundsFixed)}, 2, 2},
		{"a page added and drawn on", append([]link.Record{pageAdd(page(2), 1, nil, link.BoundsFixed)}, strokes(10, 3)...), 2, 3},
		{"a template, a removal and a new header", []link.Record{pageTemplate(page(1), dots), pageRemove(page(1)), header("Renamed")}, 4, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			all := logOf(append(append([]link.Record(nil), caughtUp...), tc.live...)...)
			rig := newReplicaRig(t, nil)
			opened, err := rig.replicas.Open(noteID)
			if err != nil {
				t.Fatal(err)
			}
			r := opened.(*NoteReplica)
			r.owner.flushBytes = 1
			if err := r.Begin(uint32(len(caughtUp))); err != nil {
				t.Fatal(err)
			}
			appendAll := func(records []link.Record) {
				for _, rec := range records {
					body, err := rec.Body()
					if err != nil {
						t.Fatal(err)
					}
					if err := r.Append(rec, body); err != nil {
						t.Fatal(err)
					}
				}
			}
			appendAll(all[:1])
			if c := rig.container(); c.Block().StringAttr("title") != "Strokes" || c.Storable().Meta()["note_device"] != aDevice.Name ||
				c.Block().Attrs["note_synced_seq"] != 0 {
				t.Errorf("first block %v", c.Block().Attrs)
			}
			appendAll(all[1:len(caughtUp)])
			if log := rig.assetOrNil(rig.container(), StrokesKey); log != nil {
				t.Errorf("the container holds %q before the catch-up settled", log)
			}
			if err := r.Settle(); err != nil {
				t.Fatal(err)
			}
			c := rig.expectHeld(all[:len(caughtUp)])
			if c.Storable().Meta()["note_pages"] != "1" || len(c.Versions()) != 1 {
				t.Errorf("caught up: face %v, %d versions", c.Storable().Meta(), len(c.Versions()))
			}
			appendAll(all[len(caughtUp):])
			if v := len(rig.container().Versions()); v != tc.live1 {
				t.Errorf("%d versions after the live records, want %d", v, tc.live1)
			}
			if err := rig.replicas.End(); err != nil {
				t.Fatal(err)
			}
			rig.expectHeld(all)
			if v := len(rig.container().Versions()); v != tc.ended || v > 2+len(tc.live) {
				t.Errorf("%d versions after End, want %d", v, tc.ended)
			}
		})
	}
}

// A replica's saves and a note's description, written through the service or straight to the
// container, never undo each other: in either order, and at once, the block and its face are the
// replica's last and the description is the last written. Writing the description moves no
// version.
func TestReplica_SavesAndADescriptionKeepEachOther(t *testing.T) {
	kind := NewDigitalNoteKind()
	for _, tc := range []struct {
		name string
		// direct writes the description straight to the container rather than through the service.
		direct bool
		// describedFirst describes before the replica's next save rather than after it.
		describedFirst bool
	}{
		{"described during the session, then saved", false, true},
		{"saved, then described", false, false},
		{"described straight to the container, then saved", true, true},
		{"saved, then described straight to the container", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newImagesRig(t, inkLog()...)
			describe := func(seq uint32) {
				t.Helper()
				edit := func(m domain.DocumentMeta) { kind.Describe(m, kitchen, seq) }
				var err error
				if tc.direct {
					_, err = rig.containers.SaveMeta(rig.uuid(), edit)
				} else {
					err = rig.svc.writeNoteMeta(rig.uuid(), edit)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			before := rig.container().Version()
			if tc.describedFirst {
				describe(6)
				if v := rig.container().Version(); v != before {
					t.Errorf("describing moved the version %d → %d", before, v)
				}
			}
			rig.append(pageAdd(page(3), 2, nil, link.BoundsFixed))
			if !tc.describedFirst {
				describe(6)
			}
			if err := rig.replicas.End(); err != nil {
				t.Fatal(err)
			}
			c := rig.container()
			meta := c.Storable().Meta()
			if meta["display_name"] != kitchen.Title || meta["note_meta_seq"] != "6" || meta["note_pages"] != "3" ||
				meta["note_synced_seq"] != "7" || c.Block().Attrs["note_synced_seq"] != 7 || c.Version() != before+1 {
				t.Errorf("version %d (from %d), .meta %v", c.Version(), before, meta)
			}
		})
	}
}

// A replica saving its block on every page added while descriptions are written beside it ends
// with its last block and face and the last description.
func TestReplica_SavesAndDescriptionsAtOnceKeepEachOther(t *testing.T) {
	const rounds = 40
	rig := newImagesRig(t, inkLog()...)
	kind := NewDigitalNoteKind()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			rig.append(pageAdd(testID(0x80+byte(i)), uint32(2+i), nil, link.BoundsFixed))
		}
	}()
	go func() {
		defer wg.Done()
		for seq := uint32(1); seq <= rounds; seq++ {
			if err := rig.svc.writeNoteMeta(rig.uuid(), func(m domain.DocumentMeta) { kind.Describe(m, kitchen, seq) }); err != nil {
				t.Error(err)
			}
		}
	}()
	wg.Wait()
	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	meta := rig.container().Storable().Meta()
	if meta["note_meta_seq"] != strconv.Itoa(rounds) || meta["note_pages"] != strconv.Itoa(2+rounds) ||
		meta["note_synced_seq"] != strconv.Itoa(6+rounds) || meta["display_name"] != kitchen.Title {
		t.Errorf(".meta %v", meta)
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

// A forgotten replica takes nothing and is not ended; restored, it takes records again and its
// queue is written as if it had never been forgotten.
func TestReplica_ForgetStopsWritesAndRestorePutsThemBack(t *testing.T) {
	records := strokesLog(2)
	rig := newReplicaRig(t, records)
	rig.replicas.flushAfter = time.Hour
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
	restore := rig.replicas.forget(r.UUID())
	if err := appendRecord(records[1]); !errors.Is(err, errForgotten) {
		t.Errorf("an Append to a forgotten replica: %v", err)
	}
	restore()
	if err := appendRecord(records[1]); err != nil {
		t.Fatalf("an Append after restore: %v", err)
	}
	c, err := rig.containers.Load(r.UUID())
	if err != nil {
		t.Fatal(err)
	}
	if err := rig.replicas.End(); err != nil {
		t.Fatal(err)
	}
	if got := rig.assetOrNil(c, StrokesKey); !bytes.Equal(got, jsonlOf(t, records[:2])) {
		t.Errorf("asset after restore and End: %q", got)
	}
}
