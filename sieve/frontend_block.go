package sieve

// FrontendBlock is the wire shape the WYSIWYG editor renders from (Stage D.2).
// It is a flattened, presentation-oriented projection of a SieveBlock with ONE
// uniform shape per kind: the payload always rides in Attrs (prose's body at
// Attrs["content"], structured props by key). Structured blocks additionally
// carry their canonical fence text in SerialisedForm (transitional, the string
// the editor's per-kind parseHTML/fence rule consumes). The frontend renders
// prose to native nodes from Attrs["content"] and structured blocks through
// their existing renderer — no ProseMirror JSON crosses the wire.
type FrontendBlock struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Attrs is the block's PROPERTIES bag — uniform across kinds. Prose's body is
	// Attrs["content"] (the client's prose renderer reads it exactly as the code
	// renderer reads Attrs["source"]); structured blocks carry their YAML props.
	// There is no kind-special-cased top-level payload field on the wire.
	Attrs map[string]interface{} `json:"attrs,omitempty"`
	// SerialisedForm is the structured block's ```kind\n<yaml>\n``` fence.
	// TRANSITIONAL: kept while the client migrates from rendering structured
	// blocks via markdownit to rendering straight from Attrs; remove once the
	// attrs path is proven (then Go serializes fences only at the disk boundary).
	SerialisedForm string   `json:"serialisedForm,omitempty"`
	Aliases        []string `json:"aliases,omitempty"`
}

// BlockDocToFrontendBlocks projects an ordered BlockDoc into the flat
// []FrontendBlock the WYSIWYG load sends to the client. Prose blocks pass their
// Content through verbatim; every other (structured/container) block is rendered
// to its fence text via the shared serializer. Containers are opaque here — their
// by-value child expansion is Stage E; for now a column-row serializes as a
// single structured fence, exactly as the codec round-trips it.
func BlockDocToFrontendBlocks(blocks []SieveBlock) ([]FrontendBlock, error) {
	out := make([]FrontendBlock, 0, len(blocks))
	for _, b := range blocks {
		// Uniform wire shape: every kind carries its payload in Attrs (prose's body
		// is Attrs["content"], the same bag code keeps "source" in). The client
		// renderer branches on kind, not on where the payload lives.
		fb := FrontendBlock{ID: b.ID, Kind: b.Kind, Aliases: b.Aliases, Attrs: b.Attrs}
		if b.Kind != KindProse {
			// Transitional fence text (removed once the attrs path is proven).
			s, err := serializeFencedBlock(b)
			if err != nil {
				return nil, err
			}
			fb.SerialisedForm = s
		}
		out = append(out, fb)
	}
	return out, nil
}
