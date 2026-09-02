// Command spelldict regenerates sieve/services/spelldata/en-variants.txt: the
// British, Canadian and Australian spellings of words the shipped American
// frequency list (en-80k.txt) holds only in their American form. The artifact
// is go:embed'ed by SpellService and loaded behind the frequency list — it is
// generated, never hand-edited.
//
// Run from the repo root:
//
//	nix develop -c env CGO_ENABLED=0 go run ./tools/spelldict
//
// The variant data is VarCon (vendored at tools/spelldict/varcon/); see
// sieve/services/spelldata/en-variants-LICENSE.txt for its provenance and terms.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	varconFile   = "tools/spelldict/varcon/varcon.txt"
	baseListFile = "sieve/services/spelldata/en-80k.txt"
	outputFile   = "sieve/services/spelldata/en-variants.txt"
)

// Generator owns the repo paths and the passes that turn VarCon plus the
// frequency list into the variant list.
type Generator struct {
	repoRoot string
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		fatal(fmt.Errorf("run from the repo root (go.mod not found in %s)", root))
	}
	if err := (&Generator{repoRoot: root}).Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "spelldict:", err)
	os.Exit(1)
}

// Run reads both inputs and writes the artifact.
func (g *Generator) Run() error {
	varcon, err := os.ReadFile(filepath.Join(g.repoRoot, varconFile))
	if err != nil {
		return err
	}
	base, err := os.ReadFile(filepath.Join(g.repoRoot, baseListFile))
	if err != nil {
		return err
	}
	variants := g.variants(string(varcon), g.frequencies(string(base)))
	out := filepath.Join(g.repoRoot, outputFile)
	if err := os.WriteFile(out, []byte(g.render(variants)), 0o644); err != nil {
		return err
	}
	fmt.Printf("spelldict: wrote %d variants to %s\n", len(variants), outputFile)
	return nil
}

// variants maps every shipped variant spelling to the frequency it inherits.
//
// A line's variants are shipped only where the base list ALREADY KNOWS the word
// in some qualifying spelling, which keeps the generated list inside the
// vocabulary the frequency list was scoped to rather than opening it to the
// whole of VarCon. They inherit the highest frequency the base list gives any
// spelling on the line, so a word ranks the same however it is spelled; where
// two lines reach the same variant, the higher frequency stands.
func (g *Generator) variants(varcon string, base map[string]int64) map[string]int64 {
	out := map[string]int64{}
	for _, line := range strings.Split(varcon, "\n") {
		forms := g.qualifyingForms(line)
		freq, known := int64(0), false
		for _, form := range forms {
			if n, ok := base[form]; ok && (!known || n > freq) {
				freq, known = n, true
			}
		}
		if !known {
			continue
		}
		for _, form := range forms {
			if _, ok := base[form]; ok {
				continue
			}
			if current, seen := out[form]; !seen || freq > current {
				out[form] = freq
			}
		}
	}
	return out
}

// qualifyingForms returns the lowercased spellings a VarCon line offers that
// Sieve will accept, in the order the line gives them.
//
// A line is entries separated by " / ", each `TAGS: word`, with anything from a
// "|" onward being usage notes rather than data. A form qualifies when at least
// one of its tags marks it as a spelling of a dialect (American, British in
// either -ise or -ize, Canadian, Australian) that is preferred, equal, or a
// used variant. Forms that are only tagged "other", and forms tagged solely as
// the discouraged or improper variants, are not spellings Sieve should accept.
//
// A form carrying anything but letters and apostrophes — hyphenated and
// multi-word entries — is dropped: a word run never spans one, so it could only
// ever sit in the dictionary unmatched.
func (g *Generator) qualifyingForms(line string) []string {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return nil
	}
	if notes := strings.Index(line, "|"); notes >= 0 {
		line = strings.TrimSpace(line[:notes])
	}
	var forms []string
	for _, entry := range strings.Split(line, " / ") {
		tags, form, ok := strings.Cut(entry, ": ")
		if !ok {
			continue
		}
		form = strings.TrimSpace(form)
		if !g.dialectal(tags) || !g.wordRun(form) {
			continue
		}
		forms = append(forms, strings.ToLower(form))
	}
	return forms
}

// dialectal reports whether a tag group marks its form as a spelling of one of
// the four dialects, in a form worth accepting. A tag is a spelling category
// followed by an optional variant indicator and an optional column number.
func (g *Generator) dialectal(tags string) bool {
	for _, tag := range strings.Fields(tags) {
		runes := []rune(tag)
		if !strings.ContainsRune("ABZCD", runes[0]) {
			continue
		}
		if len(runes) == 1 || !strings.ContainsRune("-x", runes[1]) {
			return true
		}
	}
	return false
}

// wordRun reports whether a form is a single run of letters and apostrophes —
// the shape domain.TextSegment tokenises text into, and so the only shape a
// dictionary entry can ever be looked up by.
func (g *Generator) wordRun(form string) bool {
	if form == "" {
		return false
	}
	for _, r := range form {
		switch {
		case r == '\'' || r == '’':
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		default:
			return false
		}
	}
	return true
}

// frequencies parses `word<space>frequency` lines into a lowercase-keyed map,
// the same format and fold the service loads the list with. A line that cannot
// be read costs one word, not the file.
func (g *Generator) frequencies(list string) map[string]int64 {
	out := make(map[string]int64, 80_000)
	for _, line := range strings.Split(list, "\n") {
		word, freq, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || word == "" {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSpace(freq), 10, 64)
		if err != nil {
			continue
		}
		if key := strings.ToLower(word); out[key] < n {
			out[key] = n
		}
	}
	return out
}

// render writes the list in the format the service loads: one
// `word<space>frequency` per line, alphabetical, with a trailing newline, so a
// regeneration that finds nothing new diffs as nothing.
func (g *Generator) render(variants map[string]int64) string {
	words := make([]string, 0, len(variants))
	for word := range variants {
		words = append(words, word)
	}
	sort.Strings(words)

	var b strings.Builder
	for _, word := range words {
		fmt.Fprintf(&b, "%s %d\n", word, variants[word])
	}
	return b.String()
}
