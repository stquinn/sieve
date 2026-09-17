package main

import (
	goruntime "runtime"
	"sort"
	"strings"
	"testing"

	"sieve/sieve/services"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
)

// PickDirectory is a pure path picker (no side effects) used to fill form fields
// like a containment directory grant. The native dialog can't run headless, so
// the one unit-testable contract is its guard: with no app context it must error
// rather than call into a nil Wails runtime.
func TestPickDirectory_RequiresContext(t *testing.T) {
	_, err := (&App{}).PickDirectory()
	if err == nil {
		t.Fatal("PickDirectory with nil ctx = nil error, want an error (must not dereference a nil runtime ctx)")
	}
}

// tier is where the keyboard-shortcut taxonomy puts a chord. See
// docs/editor-interaction-contract.md § Keyboard shortcut taxonomy, which this
// table is the executable half of.
type tier int

const (
	// inherited — the chord arrives with the platform (file/OS verbs) or with
	// ProseMirror/TipTap (editor verbs). Sieve conforms to it and mints no new
	// command in this tier, so every row carries the convention it conforms to.
	inherited tier = iota
	// generate — a Sieve verb that changes what the document says. Mod+Shift.
	generate
	// appearance — a Sieve verb that changes how things look or what is shown.
	// Mod+Alt.
	appearance
)

// menuChord is one row of the native menu's accelerator inventory.
type menuChord struct {
	item string // menu path, so a failure names the row to go and look at
	tier tier
	why  string // the convention an inherited chord conforms to; inherited rows only
	// only pins a row to one branch of buildMenu's goruntime.GOOS split
	// ("darwin" or "!darwin"); empty means the row is bound on every platform.
	only string
}

// menuTaxonomy is the complete set of accelerators buildMenu is allowed to bind.
// A chord in the menu but not here fails; a row here whose platform matches the
// host but which the menu no longer binds fails too.
var menuTaxonomy = map[string]menuChord{
	"Mod+N":            {item: "File › New Note", tier: inherited, why: "new document, universal"},
	"Mod+S":            {item: "File › Save", tier: inherited, why: "save, universal"},
	"Mod+W":            {item: "File › Close Tab", tier: inherited, why: "close tab/window, universal"},
	"Mod+Shift+O":      {item: "File › Open Library…", tier: inherited, why: "Shift-variant of Mod+O open"},
	"Mod+,":            {item: "File › Settings/Preferences", tier: inherited, why: "preferences, universal"},
	"Mod+Q":            {item: "File › Quit", tier: inherited, why: "quit, universal", only: "!darwin"},
	"Mod+F":            {item: "Find › Find and Replace…", tier: inherited, why: "find, universal"},
	"Mod+Shift+F":      {item: "Find › Find in Notes…", tier: inherited, why: "Shift-variant of Mod+F, project-wide find"},
	"Mod+G":            {item: "Find › Find Next", tier: inherited, why: "macOS find-next", only: "darwin"},
	"Mod+Shift+G":      {item: "Find › Find Previous", tier: inherited, why: "Shift-variant of Mod+G", only: "darwin"},
	"f3":               {item: "Edit › Find › Find Next", tier: inherited, why: "Windows/Linux find-next", only: "!darwin"},
	"Shift+f3":         {item: "Edit › Find › Find Previous", tier: inherited, why: "Shift-variant of F3", only: "!darwin"},
	"Mod+P":            {item: "View › Quick Switcher", tier: inherited, why: "go-to-file, the editor-world convention"},
	"Mod+=":            {item: "View › Increase Editor Font", tier: inherited, why: "text size, universal"},
	"Mod+-":            {item: "View › Decrease Editor Font", tier: inherited, why: "text size, universal"},
	"Mod+0":            {item: "View › Reset Editor Font", tier: inherited, why: "text size, universal"},
	"Mod+/":            {item: "Help › Shortcuts", tier: inherited, why: "shortcut sheet, universal"},
	"Mod+Alt+S":        {item: "View › Toggle Sidebar", tier: appearance},
	"Mod+Alt+I":        {item: "View › Toggle Meta Panel", tier: appearance},
	"Mod+Alt+P":        {item: "View › Toggle Prompts", tier: appearance},
	"Mod+Alt+M":        {item: "View › Toggle Editor Mode", tier: appearance},
	"Mod+Alt+J":        {item: "View › Toggle AI Blocks", tier: appearance},
	"Mod+Alt+B":        {item: "View › Show Toolbar", tier: appearance},
	"Mod+Shift+M":      {item: "Tools › Smart Metadata", tier: generate},
	"Mod+Shift+E":      {item: "Tools › Smart File", tier: generate},
	"Mod+Shift+W":      {item: "Tools › Insert WebClip", tier: generate},
	"Mod+Shift+L":      {item: "Tools › Insert URL Card", tier: generate},
	"Mod+Shift+D":      {item: "Tools › Insert Diagram", tier: generate},
	"Mod+Shift+return": {item: "Tools › Keep & Smart File", tier: generate},
}

// noRecents is a LibraryRecorder with nothing in it: buildMenu reads the recents
// list to build File › Open Recent, and those rows carry no accelerator.
type noRecents struct{}

func (noRecents) Recent() []services.Library { return nil }
func (noRecents) AddRecent(services.Library) {}
func (noRecents) LastUsed() string           { return "" }
func (noRecents) SetLastUsed(string)         {}

// chordOf renders an accelerator in the taxonomy's notation: the modifiers in
// Mod, Shift, Alt order, then the key — upper-cased when it is a single
// character, and left as the source writes it ("f3", "return") when it names a
// key instead of typing one.
func chordOf(a *keys.Accelerator) string {
	var parts []string
	for _, m := range []struct {
		mod  keys.Modifier
		word string
	}{
		{keys.CmdOrCtrlKey, "Mod"},
		{keys.ShiftKey, "Shift"},
		{keys.OptionOrAltKey, "Alt"},
		{keys.ControlKey, "Ctrl"},
	} {
		for _, have := range a.Modifiers {
			if have == m.mod {
				parts = append(parts, m.word)
			}
		}
	}
	key := a.Key
	if len([]rune(key)) == 1 {
		key = strings.ToUpper(key)
	}
	return strings.Join(append(parts, key), "+")
}

// walkMenu collects every bound accelerator in the tree, in menu order.
func walkMenu(m *menu.Menu, into *[]*menu.MenuItem) {
	if m == nil {
		return
	}
	for _, item := range m.Items {
		if item.Accelerator != nil {
			*into = append(*into, item)
		}
		walkMenu(item.SubMenu, into)
	}
}

func hasModifier(a *keys.Accelerator, want keys.Modifier) bool {
	for _, m := range a.Modifiers {
		if m == want {
			return true
		}
	}
	return false
}

// The native menu is the single owner of every app-level chord, so its
// accelerator set IS the taxonomy's surface. This walks it and holds it to the
// four rules: every chord is listed, every listed chord is in the tier its class
// requires, no chord is bound twice, and nothing that types a character is bound
// without Mod — the last is what keeps the bare-Shift, bare-Alt and Shift+Alt
// patterns out of the app, since binding one of those removes that keystroke
// from typing on every platform.
//
// buildMenu branches on goruntime.GOOS, so a run covers the host's branch only;
// rows for the other branch are pinned by menuChord.only and skipped here. The
// editor-owned chords (Mod+Shift+X Explain, Mod+K link) are bound in JS, are
// invisible to this test, and are pinned by the contract doc's editor-chord list.
func TestBuildMenu_ChordTaxonomy(t *testing.T) {
	app := &App{library: services.NewLibraryService(noRecents{}, nil)}

	var bound []*menu.MenuItem
	walkMenu(buildMenu(app), &bound)
	if len(bound) == 0 {
		t.Fatal("buildMenu bound no accelerators at all — the walk is broken, not the menu")
	}

	seen := map[string]string{} // chord → the menu item that took it first
	for _, item := range bound {
		chord := chordOf(item.Accelerator)

		if first, dup := seen[chord]; dup {
			t.Errorf("%s is bound twice: %q and %q", chord, first, item.Label)
			continue
		}
		seen[chord] = item.Label

		if len([]rune(item.Accelerator.Key)) == 1 && !hasModifier(item.Accelerator, keys.CmdOrCtrlKey) {
			t.Errorf("%s (%q) binds a printable key without Mod — that keystroke can no longer be typed into a note", chord, item.Label)
		}

		row, listed := menuTaxonomy[chord]
		if !listed {
			t.Errorf("%s (%q) is not in menuTaxonomy: place it in a tier (or justify it as inherited) before binding it", chord, item.Label)
			continue
		}
		if !strings.Contains(row.item, item.Label) {
			t.Errorf("%s is bound to %q, but menuTaxonomy assigns it to %s", chord, item.Label, row.item)
		}

		switch row.tier {
		case inherited:
			if row.why == "" {
				t.Errorf("%s (%s) is inherited but names no convention it conforms to", chord, row.item)
			}
		case generate:
			if !hasModifier(item.Accelerator, keys.CmdOrCtrlKey) || !hasModifier(item.Accelerator, keys.ShiftKey) || hasModifier(item.Accelerator, keys.OptionOrAltKey) {
				t.Errorf("%s (%s) is a generate verb and must be Mod+Shift", chord, row.item)
			}
		case appearance:
			if !hasModifier(item.Accelerator, keys.CmdOrCtrlKey) || !hasModifier(item.Accelerator, keys.OptionOrAltKey) || hasModifier(item.Accelerator, keys.ShiftKey) {
				t.Errorf("%s (%s) is an appearance verb and must be Mod+Alt", chord, row.item)
			}
		}
	}

	var stale []string
	for chord, row := range menuTaxonomy {
		switch row.only {
		case "darwin":
			if goruntime.GOOS != "darwin" {
				continue
			}
		case "!darwin":
			if goruntime.GOOS == "darwin" {
				continue
			}
		}
		if _, bound := seen[chord]; !bound {
			stale = append(stale, chord+" ("+row.item+")")
		}
	}
	sort.Strings(stale)
	for _, s := range stale {
		t.Errorf("menuTaxonomy lists %s, but buildMenu binds no such chord", s)
	}
}
