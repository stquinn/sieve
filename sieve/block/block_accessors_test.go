package block

import (
	"reflect"
	"testing"

	"sieve/sieve/domain"
)

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

// HeldAssets reads every asset attr, in every spelling an asset reference takes,
// from the attrs or the face, and from a parent's elements; an asset of another
// document and a remote URL are not held.
func TestSieveBlock_HeldAssets(t *testing.T) {
	registerParentKind(t, "fk-parent")
	self := domain.NewContainerAddress(elemDocUUID)
	own := "sieve://" + elemDocUUID + "/"
	cases := []struct {
		name  string
		block SieveBlock
		want  []string
	}{
		{"smart-image src, absolute", SieveBlock{Kind: "smart-image", Attrs: map[string]interface{}{"src": own + "holiday.png"}}, []string{"holiday.png"}},
		{"diagram svgAsset, relative", SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"svgAsset": "/flow.svg"}}, []string{"flow.svg"}},
		{"served route", SieveBlock{Kind: "smart-image", Attrs: map[string]interface{}{"src": "/ui/assets/" + elemDocUUID + "/a.png"}}, []string{"a.png"}},
		{"legacy bare filename", SieveBlock{Kind: "smart-image", Attrs: map[string]interface{}{"src": ".assets/b.png"}}, []string{"b.png"}},
		{"reference uri on the face", SieveBlock{Kind: "reference", Attrs: map[string]interface{}{FaceAttr: map[string]interface{}{"uri": own + "plan.pdf"}}}, []string{"plan.pdf"}},
		{"held attachment asset", SieveBlock{Kind: "reference", Attrs: map[string]interface{}{"asset": own + "spec.json"}}, []string{"spec.json"}},
		{"smart-card image", SieveBlock{Kind: "smart-card", Attrs: map[string]interface{}{"image": "/ui/assets/" + elemDocUUID + "/card-img.png"}}, []string{"card-img.png"}},
		{"log parsed asset", SieveBlock{Kind: "log", Attrs: map[string]interface{}{"parsedAssetRef": "/ui/assets/" + elemDocUUID + "/l-parsed.json"}}, []string{"l-parsed.json"}},
		{"another document's asset", SieveBlock{Kind: "smart-image", Attrs: map[string]interface{}{"src": "sieve://" + elemOtherUUID + "/x.png"}}, nil},
		{"remote URL", SieveBlock{Kind: "smart-card", Attrs: map[string]interface{}{"image": "https://example.com/x.png"}}, nil},
		{"an element's image", parentBlock("fk-parent", element("smart-image", map[string]interface{}{"src": own + "answer.png"})), []string{"answer.png"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.block.HeldAssets(self); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("HeldAssets = %v, want %v", got, tc.want)
			}
		})
	}
}
