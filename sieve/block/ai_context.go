package block

import "strings"

// Tag is a trailer aspect of a block's AI representation (e.g. "Specifically
// regarding"). Values are ATOMIC and stay separate across a merge (slice concat,
// never string concat), so the model sees distinct items and is never told two
// independent foci are one phrase.
type Tag struct {
	Label  string
	Values []string
}

// AIContext is the structured AI representation of one OR MORE blocks. NodeIDs is
// a member field (rendered as a header), plural because a merged context spans
// several nodes; Content is the per-member body appended on merge; Tags are
// mergeable trailers. A single block is an AIContext with a one-element NodeIDs,
// so a collection of one needs no special case. Nothing here ever fuses atoms:
// NodeIDs concat, Content appends, Tag.Values concat (deduped).
type AIContext struct {
	NodeIDs []string
	Content string
	Tags    []Tag
}

// IsEmpty reports a context carrying nothing (a not-found / empty block). Callers
// drop these, as they dropped "" before.
func (c AIContext) IsEmpty() bool {
	return len(c.NodeIDs) == 0 && c.Content == "" && len(c.Tags) == 0
}

// MergeContexts composes a collection (a MANY) into ONE AIContext. The three
// operations are uniform and kind-blind: NodeIDs slice-concat, Content append
// (blank-line separated, empty bodies skipped), Tags union by Label with Values
// slice-concat + dedup (stable order). Merge of one element is the identity.
func MergeContexts(cs []AIContext) AIContext {
	var out AIContext
	tagIdx := map[string]int{}
	var contents []string
	for _, c := range cs {
		out.NodeIDs = append(out.NodeIDs, c.NodeIDs...)
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

// String renders the context: a NODE ID header (the joined id list), the content,
// then each tag as `Label: "v1", "v2"`. Header/trailer are omitted when empty, so
// a "doc" context (no ids) or a tagless block render cleanly.
func (c AIContext) String() string {
	var b strings.Builder
	if len(c.NodeIDs) > 0 {
		b.WriteString("NODE ID: ")
		b.WriteString(strings.Join(c.NodeIDs, ","))
		if c.Content != "" || len(c.Tags) > 0 {
			b.WriteString("\n")
		}
	}
	b.WriteString(c.Content)
	for _, t := range c.Tags {
		if len(t.Values) == 0 {
			continue
		}
		quoted := make([]string, len(t.Values))
		for i, v := range t.Values {
			quoted[i] = `"` + v + `"`
		}
		b.WriteString("\n\n")
		b.WriteString(t.Label)
		b.WriteString(": ")
		b.WriteString(strings.Join(quoted, ", "))
	}
	return b.String()
}
