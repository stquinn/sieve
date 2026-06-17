package sieve

// DocBlock is a node in the unified, ordered block tree (spec §2). It supersedes
// the flat map[id]*SieveBlock model for serialization. Which payload field is
// meaningful depends on Kind:
//   - prose kinds      → Content holds verbatim markdown; Attrs/Children nil
//   - structured kinds → Attrs holds the fenced YAML payload; Content ""; Children nil
//   - container kinds  → Children holds the subtree; Attrs may hold layout (e.g. widths)
//
// ID is the block's primary handle. In Stage A prose blocks have an empty ID
// (positional); Stage B assigns universal {id=} handles.
type DocBlock struct {
	ID       string
	Kind     string
	Content  string
	Attrs    map[string]interface{}
	Children []DocBlock
}

// BlockDoc is an ordered list of top-level blocks — a tree wherever containers
// nest Children. It is the in-memory form the serialization spine round-trips
// against markdown.
type BlockDoc struct {
	Blocks []DocBlock
}

// Reserved kinds that are not registered BlockProcessors.
const (
	KindProse     = "prose"
	KindColumnRow = "column-row"
	KindColumn    = "column"
)
