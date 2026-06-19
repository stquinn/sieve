package domain

import (
	"strconv"
	"strings"
	"time"
)

// DocumentMeta is the typed contract over the map[string]string that travels
// with every MetaStorable. Keys match the YAML frontmatter field names exactly.
// Always access fields through this interface in business code — never read or
// write the raw map directly outside the store package.
type DocumentMeta interface {
	// Status is a pass-through for backward compat with existing files and
	// external editors. No setter — the business type (Buffer vs Note) is the
	// authoritative signal for whether a document is filed.
	Status() string

	// Version is read-only — the Store stamps it on every Save.
	Version() int

	FocusCount() int
	SetFocusCount(v int)

	UserIntent() *string
	SetUserIntent(v *string)

	AiEval() string
	SetAiEval(v string)

	AiLastEvaluated() *string
	SetAiLastEvaluated(v *string)

	AiFolderSuggestion() *string
	SetAiFolderSuggestion(v *string)

	UserSuggestedName() *string
	SetUserSuggestedName(v *string)

	DisplayName() string
	SetDisplayName(v string)

	Filename() *string
	SetFilename(v *string)

	Summary() *string
	SetSummary(v *string)

	Tags() []string
	SetTags(v []string)

	AiJustification() *string
	SetAiJustification(v *string)

	DensitySignals() []string
	SetDensitySignals(v []string)

	// Created is read-only — stamped by the Store at Create time.
	Created() time.Time

	// Modified is read-only — stamped by the Store on every Save.
	Modified() time.Time

	CLI() *string
	SetCLI(v *string)

	AiKeep() *bool
	SetAiKeep(v *bool)

	Scroll() int
	SetScroll(v int)

	Mode() string
	SetMode(v string)

	// All returns the full underlying meta map. Unknown keys round-trip
	// untouched. Prefer typed accessors for known fields; use All for
	// inspection or access to custom/unknown keys.
	All() map[string]string
}

// documentMeta wraps a map[string]string with typed accessors. It holds a
// direct reference to the map owned by the MetaStorable — mutations are visible
// immediately. The commit function (MetaStorable.SetMeta) is called after every
// Set* to explicitly signal the change.
type documentMeta struct {
	m      map[string]string
	commit func(map[string]string)
}

// NewDocumentMeta constructs a DocumentMeta view over m. commit should be
// MetaStorable.SetMeta and is called after each Set* mutation.
func NewDocumentMeta(m map[string]string, commit func(map[string]string)) DocumentMeta {
	return &documentMeta{m: m, commit: commit}
}

func (d *documentMeta) set(key, value string) {
	d.m[key] = value
	d.commit(d.m)
}

// ── Read-only system fields ───────────────────────────────────────────────────

func (d *documentMeta) Status() string         { return d.m["status"] }
func (d *documentMeta) Version() int           { return metaInt(d.m, "version") }
func (d *documentMeta) Created() time.Time     { return metaTime(d.m, "created") }
func (d *documentMeta) Modified() time.Time    { return metaTime(d.m, "modified") }
func (d *documentMeta) All() map[string]string { return d.m }

// ── Typed read/write fields ───────────────────────────────────────────────────

func (d *documentMeta) FocusCount() int     { return metaInt(d.m, "focus_count") }
func (d *documentMeta) SetFocusCount(v int) { d.set("focus_count", strconv.Itoa(v)) }

func (d *documentMeta) UserIntent() *string     { return metaNullableStr(d.m, "user_intent") }
func (d *documentMeta) SetUserIntent(v *string) { d.set("user_intent", nullableStrVal(v)) }

func (d *documentMeta) AiEval() string     { return metaStrDefault(d.m, "ai_eval", "none") }
func (d *documentMeta) SetAiEval(v string) { d.set("ai_eval", v) }

func (d *documentMeta) AiLastEvaluated() *string     { return metaNullableStr(d.m, "ai_last_evaluated") }
func (d *documentMeta) SetAiLastEvaluated(v *string) { d.set("ai_last_evaluated", nullableStrVal(v)) }

func (d *documentMeta) AiFolderSuggestion() *string {
	return metaNullableStr(d.m, "ai_folder_suggestion")
}
func (d *documentMeta) SetAiFolderSuggestion(v *string) {
	d.set("ai_folder_suggestion", nullableStrVal(v))
}

func (d *documentMeta) UserSuggestedName() *string {
	return metaNullableStr(d.m, "user_suggested_name")
}
func (d *documentMeta) SetUserSuggestedName(v *string) {
	d.set("user_suggested_name", nullableStrVal(v))
}

func (d *documentMeta) DisplayName() string     { return d.m["display_name"] }
func (d *documentMeta) SetDisplayName(v string) { d.set("display_name", v) }

func (d *documentMeta) Filename() *string     { return metaNullableStr(d.m, "filename") }
func (d *documentMeta) SetFilename(v *string) { d.set("filename", nullableStrVal(v)) }

func (d *documentMeta) Summary() *string     { return metaNullableStr(d.m, "summary") }
func (d *documentMeta) SetSummary(v *string) { d.set("summary", nullableStrVal(v)) }

func (d *documentMeta) Tags() []string     { return metaList(d.m, "tags") }
func (d *documentMeta) SetTags(v []string) { d.set("tags", listVal(v)) }

func (d *documentMeta) AiJustification() *string     { return metaNullableStr(d.m, "ai_justification") }
func (d *documentMeta) SetAiJustification(v *string) { d.set("ai_justification", nullableStrVal(v)) }

func (d *documentMeta) DensitySignals() []string     { return metaList(d.m, "density_signals") }
func (d *documentMeta) SetDensitySignals(v []string) { d.set("density_signals", listVal(v)) }

func (d *documentMeta) CLI() *string     { return metaNullableStr(d.m, "cli") }
func (d *documentMeta) SetCLI(v *string) { d.set("cli", nullableStrVal(v)) }

func (d *documentMeta) AiKeep() *bool     { return metaNullableBool(d.m, "ai_keep") }
func (d *documentMeta) SetAiKeep(v *bool) { d.set("ai_keep", nullableBoolVal(v)) }

func (d *documentMeta) Scroll() int     { return metaInt(d.m, "scroll") }
func (d *documentMeta) SetScroll(v int) { d.set("scroll", strconv.Itoa(v)) }

func (d *documentMeta) Mode() string     { return d.m["mode"] }
func (d *documentMeta) SetMode(v string) { d.set("mode", v) }

// ── Low-level conversion helpers ─────────────────────────────────────────────
//
// The meta map wire format (from filestore/meta.go yamlValueToString):
//   nil / absent  → "null"
//   bool          → "true" / "false"
//   int           → decimal string
//   []string      → "[]" or "[a, b, c]"  (YAML inline list)
//   time.Time     → "2006-01-02T15:04:05"

func metaInt(m map[string]string, key string) int {
	n, _ := strconv.Atoi(m[key])
	return n
}

func metaStrDefault(m map[string]string, key, def string) string {
	if v := m[key]; v != "" && v != "null" {
		return v
	}
	return def
}

func metaNullableStr(m map[string]string, key string) *string {
	v := m[key]
	if v == "" || v == "null" {
		return nil
	}
	s := v
	return &s
}

func nullableStrVal(v *string) string {
	if v == nil {
		return "null"
	}
	return *v
}

func metaNullableBool(m map[string]string, key string) *bool {
	switch m[key] {
	case "true":
		b := true
		return &b
	case "false":
		b := false
		return &b
	}
	return nil
}

func nullableBoolVal(v *bool) string {
	if v == nil {
		return "null"
	}
	if *v {
		return "true"
	}
	return "false"
}

// metaList parses a YAML inline list value from the meta map.
// Stored as "[]" or "[a, b, c]" by filestore/meta.go.
func metaList(m map[string]string, key string) []string {
	s := strings.TrimSpace(m[key])
	if s == "" || s == "null" || s == "[]" {
		return []string{}
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		inner := s[1 : len(s)-1]
		parts := strings.Split(inner, ",")
		result := make([]string, 0, len(parts))
		for _, p := range parts {
			if t := strings.TrimSpace(p); t != "" {
				result = append(result, t)
			}
		}
		return result
	}
	// Unexpected format — treat as a single-item list.
	return []string{s}
}

func listVal(v []string) string {
	if len(v) == 0 {
		return "[]"
	}
	return "[" + strings.Join(v, ", ") + "]"
}

func metaTime(m map[string]string, key string) time.Time {
	t, _ := time.Parse("2006-01-02T15:04:05", m[key])
	return t
}
