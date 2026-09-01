package services

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"

	"sieve/sieve/domain"
	"sieve/store/filestore"
)

func newTestStateService(t *testing.T, storePath string, themes any) (*StateService, string) {
	t.Helper()
	if storePath == "" {
		storePath = t.TempDir()
	}
	fs, err := filestore.NewFileStore(storePath, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	var themeFS fstest.MapFS
	if m, ok := themes.(fstest.MapFS); ok {
		themeFS = m
	}
	ss, err := NewStateService(fs, storePath, themeFS)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	return ss, storePath
}

// A store-local theme override file wins over the embedded builtins, and
// metadata keys (leading underscore) are stripped from the resolved vars.
func TestStateService_ActiveThemeVars_storeOverrideWins(t *testing.T) {
	ss, storePath := newTestStateService(t, "", fstest.MapFS{
		"themes/custom.json": {Data: []byte(`{"bg":"#ffffff"}`)}, // builtin, should lose
	})

	themesDir := filepath.Join(storePath, "themes")
	if err := os.MkdirAll(themesDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(themesDir, "custom.json"),
		[]byte(`{"bg":"#101010","fg":"#eeeeee","_name":"Custom"}`), 0o644); err != nil {
		t.Fatalf("write override: %v", err)
	}

	settings := domain.DefaultSettings()
	settings.Theme = "custom"
	if err := ss.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	vars := ss.ActiveThemeVars()
	if vars["bg"] != "#101010" {
		t.Errorf("bg: got %q, want store-local override #101010", vars["bg"])
	}
	if vars["fg"] != "#eeeeee" {
		t.Errorf("fg: got %q, want #eeeeee", vars["fg"])
	}
	if _, ok := vars["_name"]; ok {
		t.Error("metadata key _name must be stripped")
	}
}

// With no store-local override, resolution falls through to the embedded builtins.
func TestStateService_ActiveThemeVars_embeddedFallback(t *testing.T) {
	ss, _ := newTestStateService(t, "", fstest.MapFS{
		"themes/tokyonight.json": {Data: []byte(`{"bg":"#1a1b26"}`)},
	})

	settings := domain.DefaultSettings()
	settings.Theme = "tokyonight"
	if err := ss.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	if got := ss.ActiveThemeVars()["bg"]; got != "#1a1b26" {
		t.Errorf("bg: got %q, want embedded #1a1b26", got)
	}
}

// The user dictionary is a line-per-word file the StateService owns. It reads
// back what it wrote, an unwritten one is empty rather than an error, and blank
// lines a hand edit leaves behind are skipped.
func TestStateService_UserDictionaryRoundTrip(t *testing.T) {
	ss, _ := newTestStateService(t, "", nil)

	if words := ss.LoadUserDictionary(); len(words) != 0 {
		t.Errorf("a store with no dictionary returned %v, want none", words)
	}
	if err := ss.SaveUserDictionary([]string{"zzblorp", "zzquux"}); err != nil {
		t.Fatalf("SaveUserDictionary: %v", err)
	}
	if got := ss.LoadUserDictionary(); !slices.Equal(got, []string{"zzblorp", "zzquux"}) {
		t.Errorf("LoadUserDictionary = %v, want the two words written", got)
	}

	if err := ss.SaveUserDictionary([]string{"", "  zzblorp  ", ""}); err != nil {
		t.Fatalf("SaveUserDictionary: %v", err)
	}
	if got := ss.LoadUserDictionary(); !slices.Equal(got, []string{"zzblorp"}) {
		t.Errorf("LoadUserDictionary = %v, want blank lines skipped and the word trimmed", got)
	}

	if err := ss.SaveUserDictionary(nil); err != nil {
		t.Fatalf("SaveUserDictionary(nil): %v", err)
	}
	if got := ss.LoadUserDictionary(); len(got) != 0 {
		t.Errorf("LoadUserDictionary = %v, want an emptied dictionary", got)
	}
}
