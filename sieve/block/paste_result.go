package block

// PasteOutcome discriminates what a paste round-trip actually did. It is the tag of
// PasteResult: nothing else in the payload is meaningful without it, and the caller
// (today the HTTP handler, tomorrow the command channel) switches on it rather than
// inspecting which fields happen to be populated.
type PasteOutcome string

const (
	// OutcomeNothing — no kind claimed the views and they are not a link. The paste
	// is not a Sieve concern: the frontend replays the raw clipboard locally at the
	// intact caret, exactly as it did for the old matched:false.
	OutcomeNothing PasteOutcome = "none"
	// OutcomeBlock — a Sieve block was created. The block itself arrives over the
	// insert-block render-back (Go places its authoritative node at its own index);
	// this result only tells the caller which block, so it can consume the caret.
	OutcomeBlock PasteOutcome = "block"
	// OutcomeContent — Go composed a fragment for the frontend to insert at the
	// caret. No block, no render-back: ordinary document content Go happened to be
	// better placed to build (a link whose title it fetched, #67).
	OutcomeContent PasteOutcome = "content"
)

// PasteResult is what one paste did — a discriminated union, not a bag of optional
// flags. It is deliberately transport-blind: the JSON tags are the wire contract for
// POST /api/editor/smart-paste today, and the same value is what a future
// command-channel paste would carry, so that migration is a transport swap.
//
// Construct one through PasteBlock/PasteContent/PasteNothing — never as a literal,
// so the discriminator is never left unset.
type PasteResult struct {
	Outcome PasteOutcome `json:"outcome"`

	// OutcomeBlock only.
	Kind    string `json:"kind,omitempty"`
	ID      string `json:"id,omitempty"`
	RawYaml string `json:"rawYaml,omitempty"`

	// OutcomeContent only: an HTML fragment, already escaped, safe to insert.
	HTML string `json:"html,omitempty"`
}

// PasteBlock reports that a block of kind/id was created.
func PasteBlock(kind, id, rawYaml string) PasteResult {
	return PasteResult{Outcome: OutcomeBlock, Kind: kind, ID: id, RawYaml: rawYaml}
}

// PasteContent reports a fragment for the frontend to insert at the caret.
func PasteContent(html string) PasteResult {
	return PasteResult{Outcome: OutcomeContent, HTML: html}
}

// PasteNothing reports that Sieve did nothing with the paste.
func PasteNothing() PasteResult { return PasteResult{Outcome: OutcomeNothing} }

// IsBlock reports that this paste created a block — the only outcome a caller that
// needs a block id (e.g. the slice reconstruction) can proceed with.
func (r PasteResult) IsBlock() bool { return r.Outcome == OutcomeBlock }
