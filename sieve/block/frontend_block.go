package block

// FrontendBlock is the wire shape the WYSIWYG editor renders from (Stage D.2).
// It is a flattened, presentation-oriented projection of a SieveBlock with ONE
// uniform shape per kind: the payload always rides in Attrs (prose's body at
// Attrs["content"], structured props by key). The frontend renders prose to native
// nodes from Attrs["content"] and structured blocks through their renderer straight
// from Attrs — no markdown and no ProseMirror JSON cross the wire.
type FrontendBlock struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Attrs is the block's PROPERTIES bag — uniform across kinds. Prose's body is
	// Attrs["content"] (the client's prose renderer reads it exactly as the code
	// renderer reads Attrs["source"]); structured blocks carry their YAML props.
	// There is no kind-special-cased top-level payload field on the wire.
	Attrs   map[string]interface{} `json:"attrs,omitempty"`
	Aliases []string               `json:"aliases,omitempty"`
}

// BlockDocToFrontendBlocks projects an ordered BlockDoc into the flat
// []FrontendBlock the WYSIWYG load sends to the client. Every kind carries its
// payload in Attrs (prose's body is Attrs["content"], the same bag code keeps
// "source" in); the client renderer branches on kind, not on where the payload
// lives. No markdown is produced — Go serializes fences only at the disk boundary.
func BlockDocToFrontendBlocks(blocks []SieveBlock) ([]FrontendBlock, error) {
	out := make([]FrontendBlock, 0, len(blocks))
	for _, b := range blocks {
		out = append(out, FrontendBlock{ID: b.ID, Kind: b.Kind, Aliases: b.Aliases, Attrs: b.Attrs})
	}
	return out, nil
}
