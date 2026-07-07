package sieve

import (
	"os"
	"path/filepath"
	"testing"

	"sieve/sieve/services"
)

// fakeRecorder is a minimal services.LibraryRecorder for exercising the
// FileLibraryService open/fallback decision logic without touching real config.
type fakeRecorder struct {
	recent   []services.Library
	lastUsed string
	added    []services.Library
	setLast  []string
}

func (f *fakeRecorder) Recent() []services.Library   { return f.recent }
func (f *fakeRecorder) AddRecent(l services.Library) { f.added = append(f.added, l) }
func (f *fakeRecorder) LastUsed() string             { return f.lastUsed }
func (f *fakeRecorder) SetLastUsed(id string)        { f.setLast = append(f.setLast, id) }

// newTestService wires a FileLibraryService with a broadcast/onOpened recorder so
// the bootstrap paths can be asserted to have NO side effects.
func newTestService(rec services.LibraryRecorder, validate func(string) error) (*FileLibraryService, *[]string, *bool) {
	var broadcasts []string
	opened := false
	l := NewLibraryService(rec, validate, &ServiceProvider{}, func(ev, _ string) {
		broadcasts = append(broadcasts, ev)
	}, nil)
	l.OnOpened(func() { opened = true })
	return l, &broadcasts, &opened
}

func alwaysInvalid(string) error { return os.ErrInvalid }

func TestOpen_EmptyPath_EntersBootstrap(t *testing.T) {
	l, broadcasts, opened := newTestService(&fakeRecorder{}, alwaysInvalid)

	got, err := l.Open("", true)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if got != "" {
		t.Fatalf("Open = %q, want empty (bootstrap)", got)
	}
	if l.StorePath() != "" {
		t.Fatalf("StorePath = %q, want empty", l.StorePath())
	}
	if *opened {
		t.Fatal("onOpened fired on bootstrap path")
	}
	if len(*broadcasts) != 0 {
		t.Fatalf("broadcasts = %v, want none", *broadcasts)
	}
}

func TestOpen_InvalidNonEmptyDir_FirstStartup_NoFallback_Bootstrap(t *testing.T) {
	dir := t.TempDir()
	// Non-empty dir so the empty-dir init branch is skipped.
	if err := os.WriteFile(filepath.Join(dir, "junk.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// validate always fails; recents empty + no last-used + cwd invalid -> "".
	rec := &fakeRecorder{}
	l, broadcasts, opened := newTestService(rec, alwaysInvalid)

	got, err := l.Open(dir, true)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if got != "" {
		t.Fatalf("Open = %q, want empty (bootstrap)", got)
	}
	if l.StorePath() != "" {
		t.Fatalf("StorePath = %q, want empty", l.StorePath())
	}
	if *opened || len(*broadcasts) != 0 {
		t.Fatalf("unexpected side effects: opened=%v broadcasts=%v", *opened, *broadcasts)
	}
	if len(rec.added) != 0 || len(rec.setLast) != 0 {
		t.Fatalf("recorder mutated on bootstrap path: added=%v setLast=%v", rec.added, rec.setLast)
	}
}

func TestOpen_InvalidNonEmptyDir_NotFirstStartup_Bootstrap(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "junk.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Not first startup: an explicit invalid path re-enters bootstrap directly,
	// without consulting the recents fallback that a cold start would offer.
	rec := &fakeRecorder{recent: []services.Library{{Ref: "/some/other/lib", Name: "Other"}}}
	l, broadcasts, opened := newTestService(rec, alwaysInvalid)

	got, err := l.Open(dir, false)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if got != "" {
		t.Fatalf("Open = %q, want empty (bootstrap)", got)
	}
	if *opened || len(*broadcasts) != 0 {
		t.Fatalf("unexpected side effects: opened=%v broadcasts=%v", *opened, *broadcasts)
	}
	if len(rec.added) != 0 {
		t.Fatalf("RecordSwitch AddRecent called on bootstrap path: %v", rec.added)
	}
}
