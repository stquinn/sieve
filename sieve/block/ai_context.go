package block

import (
	"fmt"
	"strings"
)

// Tag is a trailer aspect of a block's AI representation (e.g. "Specifically
// regarding"). Values are ATOMIC and stay separate across a merge (slice concat,
// never string concat), so the model sees distinct items and is never told two
// independent foci are one phrase.
type Tag struct {
	Label  string
	Values []string
}

// AIContext is the structured AI representation of one OR MORE blocks. Addresses
// are the absolute sieve:// addresses of the blocks it speaks for (rendered as the
// ADDRESS header), plural because a merged context spans several nodes; Content is
// the per-member body appended on merge; Tags are mergeable trailers. A single
// block is an AIContext with a one-element Addresses, so a collection of one needs
// no special case. A context built with no container to address against has no
// Addresses and renders no header: a bare id is never a stand-in. Nothing here
// ever fuses atoms: Addresses concat, Content appends, Tag.Values concat (deduped).
//
// Kind names what the context speaks for, in the noun a model reads in an entry
// marker: a block's own kind string, "document" for the whole document, a
// reference element's kind for one that is not in this document. It is empty when
// the producer did not set it, and a merge does not carry it.
type AIContext struct {
	Kind      string
	Addresses []string
	Content   string
	Tags      []Tag
}

// IsEmpty reports a context carrying nothing (a not-found / empty block). Callers
// drop these, as they dropped "" before.
func (c AIContext) IsEmpty() bool {
	return len(c.Addresses) == 0 && c.Content == "" && len(c.Tags) == 0
}

// Speaks reports whether the context has anything to show a model: content that
// is not whitespace, or a tag. An address alone says nothing. ContextSeries
// shows exactly the members that speak.
func (c AIContext) Speaks() bool {
	return strings.TrimSpace(c.Content) != "" || len(c.Tags) > 0
}

// MergeContexts composes a collection (a MANY) into ONE AIContext. The three
// operations are uniform and kind-blind: Addresses slice-concat, Content append
// (blank-line separated, empty bodies skipped), Tags union by Label with Values
// slice-concat + dedup (stable order). Merge of one element is the identity.
func MergeContexts(cs []AIContext) AIContext {
	var out AIContext
	tagIdx := map[string]int{}
	var contents []string
	for _, c := range cs {
		out.Addresses = append(out.Addresses, c.Addresses...)
		if strings.TrimSpace(c.Content) != "" {
			contents = append(contents, c.Content)
		}
		for _, t := range c.Tags {
			i, ok := tagIdx[t.Label]
			if !ok {
				i = len(out.Tags)
				tagIdx[t.Label] = i
				out.Tags = append(out.Tags, Tag{Label: t.Label})
			}
			for _, v := range t.Values {
				if !containsString(out.Tags[i].Values, v) {
					out.Tags[i].Values = append(out.Tags[i].Values, v)
				}
			}
		}
	}
	out.Content = strings.Join(contents, "\n\n")
	return out
}

func containsString(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// String renders the context: an ADDRESS header (the joined address list), the
// content, then each tag as `Label: "v1", "v2"`. Header/trailer are omitted when
// empty, so a whole-document context (no addresses) or a tagless block render
// cleanly.
func (c AIContext) String() string {
	return c.body() + c.trailers()
}

// OfKind returns c with Kind set to kind when the producer left it empty.
func (c AIContext) OfKind(kind string) AIContext {
	if c.Kind == "" {
		c.Kind = kind
	}
	return c
}

// body is the context without its trailers: the ADDRESS header, when it has
// addresses, then the content.
func (c AIContext) body() string {
	var b strings.Builder
	if len(c.Addresses) > 0 {
		b.WriteString("ADDRESS: ")
		b.WriteString(strings.Join(c.Addresses, ","))
		if c.Content != "" || len(c.Tags) > 0 {
			b.WriteString("\n")
		}
	}
	b.WriteString(c.Content)
	return b.String()
}

// trailers renders each tag as a blank line then `Label: "v1", "v2"`. A tag
// value that is empty or whitespace is skipped, so a renderer can add tags
// unconditionally; a tag with no non-empty value is dropped entirely.
func (c AIContext) trailers() string {
	var b strings.Builder
	for _, t := range c.Tags {
		var quoted []string
		for _, v := range t.Values {
			if strings.TrimSpace(v) == "" {
				continue
			}
			quoted = append(quoted, `"`+v+`"`)
		}
		if len(quoted) == 0 {
			continue
		}
		b.WriteString("\n\n")
		b.WriteString(t.Label)
		b.WriteString(": ")
		b.WriteString(strings.Join(quoted, ", "))
	}
	return b.String()
}

// ContextSeries is an ordered run of contexts shown to a model as separate
// entries, each opened by a numbered marker line. Members with nothing to say are
// dropped and not counted, so n and m number what is printed.
type ContextSeries []AIContext

// entries returns the members that say something, in order: one with only an
// address, or only whitespace, has nothing to show a model and is dropped.
func (s ContextSeries) entries() []AIContext {
	out := make([]AIContext, 0, len(s))
	for _, c := range s {
		if c.Speaks() {
			out = append(out, c)
		}
	}
	return out
}

// marker is the line opening entry n of m: `===== NOUN n of m =====`, with
// ` · qualifier` after the count when the qualifier is not empty.
func (ContextSeries) marker(noun string, n, m int, qualifier string) string {
	if qualifier != "" {
		qualifier = " \u00b7 " + qualifier
	}
	return fmt.Sprintf("===== %s %d of %d%s =====", noun, n, m, qualifier)
}

// Turns renders the series as a THREAD: each member whole, trailers included,
// under its own `===== TURN n of m =====` line, separated by a blank line.
func (s ContextSeries) Turns() string {
	es := s.entries()
	parts := make([]string, len(es))
	for i, c := range es {
		parts[i] = s.marker("TURN", i+1, len(es), "") + "\n" + c.String()
	}
	return strings.Join(parts, "\n\n")
}

// Blocks renders the series as a TARGET: each member's ADDRESS header and content
// under its own `===== BLOCK n of m · kind =====` line, separated by a blank
// line, then the members' tags unioned (as MergeContexts does) and printed once
// after the last entry. A member with no addresses prints no ADDRESS line. An
// empty series renders as "".
func (s ContextSeries) Blocks() string {
	es := s.entries()
	parts := make([]string, len(es))
	for i, c := range es {
		parts[i] = s.marker("BLOCK", i+1, len(es), c.Kind) + "\n" + c.body()
	}
	return strings.Join(parts, "\n\n") + MergeContexts(es).trailers()
}
