package sieve

import "testing"

// Typed attr accessors (spec #5): kind-agnostic storage, typed reads — so a
// typo or shape change is a compile error / empty string, not a silent panic.
// They front the single Attrs payload bag that every kind shares.
func TestDocBlock_TypedAccessors(t *testing.T) {
	b := DocBlock{
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
	// Content() arrives in Task 4, when the colliding Content string field is
	// removed and prose moves to Attrs["content"].
}

// Missing/nil/wrong-type attrs return "" rather than panicking — the whole point
// of the typed accessor over a raw b.Attrs["x"].(string) cast.
func TestDocBlock_TypedAccessors_SafeOnMissing(t *testing.T) {
	var b DocBlock // nil Attrs
	if got := b.Source(); got != "" {
		t.Errorf("Source() on nil attrs = %q, want empty", got)
	}

	b2 := DocBlock{Attrs: map[string]interface{}{"status": 42}} // wrong type
	if got := b2.Status(); got != "" {
		t.Errorf("Status() on non-string = %q, want empty", got)
	}
	if got := b2.StringAttr("nope"); got != "" {
		t.Errorf("StringAttr(missing) = %q, want empty", got)
	}
}
