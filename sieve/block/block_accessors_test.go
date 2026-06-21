package block

import "testing"

// Typed attr accessors (spec #5): kind-agnostic storage, typed reads — so a
// typo or shape change is a compile error / empty string, not a silent panic.
// They front the single Attrs payload bag that every kind shares.
func TestSieveBlock_TypedAccessors(t *testing.T) {
	b := SieveBlock{
		ID:   "co-1",
		Kind: "code",
		Attrs: map[string]interface{}{
			"source":   "fmt.Println()",
			"status":   "complete",
			"ref":      "pr-1,pr-2",
			"language": "go",
		},
	}

	if got := b.Source(); got != "fmt.Println()" {
		t.Errorf("Source() = %q, want %q", got, "fmt.Println()")
	}
	if got := b.Status(); got != "complete" {
		t.Errorf("Status() = %q, want %q", got, "complete")
	}
	if got := b.Ref(); got != "pr-1,pr-2" {
		t.Errorf("Ref() = %q, want %q", got, "pr-1,pr-2")
	}
	if got := b.StringAttr("language"); got != "go" {
		t.Errorf("StringAttr(language) = %q, want %q", got, "go")
	}

	pr := SieveBlock{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "verbatim prose body"}}
	if got := pr.Content(); got != "verbatim prose body" {
		t.Errorf("Content() = %q, want %q", got, "verbatim prose body")
	}
}

// Missing/nil/wrong-type attrs return "" rather than panicking — the whole point
// of the typed accessor over a raw b.Attrs["x"].(string) cast.
func TestSieveBlock_TypedAccessors_SafeOnMissing(t *testing.T) {
	var b SieveBlock // nil Attrs
	if got := b.Source(); got != "" {
		t.Errorf("Source() on nil attrs = %q, want empty", got)
	}

	b2 := SieveBlock{Attrs: map[string]interface{}{"status": 42}} // wrong type
	if got := b2.Status(); got != "" {
		t.Errorf("Status() on non-string = %q, want empty", got)
	}
	if got := b2.StringAttr("nope"); got != "" {
		t.Errorf("StringAttr(missing) = %q, want empty", got)
	}
}
