package sieve

// FrontendBlock is the wire shape the WYSIWYG editor renders from (Stage D.2).
// It is a flattened, presentation-oriented projection of a DocBlock: prose
// blocks travel as verbatim markdown in Content; structured blocks travel as
// their canonical fence text in SerialisedForm (the same string the editor's
// existing per-kind parseHTML/fence rule consumes). The frontend wraps each
// prose block in a `sieve-prose` node carrying ID/Aliases and renders each
// structured block through its existing renderer — no ProseMirror JSON crosses
// the wire.
type FrontendBlock struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Content is prose: verbatim markdown.
	Content string `json:"content,omitempty"`
	// Attrs is the structured block's PROPERTIES — the block model is
	// properties-in/properties-out, so the client renders the NodeView straight
	// from these (no markdown re-parse). Nil for prose.
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
// single structured fence, exactly as ParseBlockDoc round-trips it.
func BlockDocToFrontendBlocks(doc BlockDoc) ([]FrontendBlock, error) {
	out := make([]FrontendBlock, 0, len(doc.Blocks))
	for _, b := range doc.Blocks {
		fb := FrontendBlock{ID: b.ID, Kind: b.Kind, Aliases: b.Aliases}
		if b.Kind == KindProse {
			fb.Content = b.Content
		} else {
			// Properties-native: the client renders structured NodeViews from Attrs.
			fb.Attrs = b.Attrs
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
