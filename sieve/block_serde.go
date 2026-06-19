package sieve

import "sieve/sieve/fencedblock"

// block_serde.go — block serialization/deserialization helpers and handle
// split/merge identity rules (spec §7).
//
// The two public entry-points (ParseBlockDocWithHandles /
// SerializeBlockDocWithHandles) are thin codec shims retained for callsites
// that have not yet migrated to DocumentCodec directly.  serializeBlock and
// serializeFencedBlock are the per-block dispatch helpers used by the save
// spine.  splitHandles / mergeHandles govern how block identity propagates
// when the user inserts or removes a block boundary.

// ParseBlockDocWithHandles is the handle-aware loader — now a thin codec shim,
// exactly mirroring SerializeBlockDocWithHandles. Structure derives ONLY from
// delimiters: top-level structured fences (atomic, opaque) and paired
// `<!--s:ID--> … <!--/s:ID-->` prose blocks. Unbalanced opens are literal text;
// undelimited runs become a single opaque prose block. Blank lines never split.
func ParseBlockDocWithHandles(markdown string) ([]SieveBlock, error) {
	return NewDocumentCodec(globalRegistry()).Deserialize(markdown)
}

// SerializeBlockDocWithHandles is a thin shim retained during the codec
// migration; callers move to DocumentCodec.Serialize in Task 8.
func SerializeBlockDocWithHandles(blocks []SieveBlock) (string, error) {
	return NewDocumentCodec(globalRegistry()).Serialize(blocks)
}

// serializeBlock dispatches a single block to its flavour's Serialize. The save
// spine never decides format by kind — the processor does. The fence fallback
// covers processor-less kinds (column-row) until Stage E gives them a processor.
func serializeBlock(b SieveBlock) (string, error) {
	if p := GetProcessor(b.Kind); p != nil {
		return p.Serialize(b)
	}
	return serializeFencedBlock(b)
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, column-row, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b SieveBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
}

// splitHandles applies the split handle rule (Enter mid-block, spec §7): the
// head keeps ALL its handles unchanged; the tail mints exactly one fresh handle
// and answers to nothing else. Undoing a split therefore just discards the tail
// — the head was never touched, so no stray handle remains. Content assignment
// is the caller's concern; this governs identity only.
func splitHandles(head SieveBlock) (SieveBlock, SieveBlock) {
	tail := SieveBlock{ID: GenerateBlockID(KindProse), Kind: KindProse}
	return head, tail
}

// mergeHandles applies the merge handle rule (Backspace at start, spec §7): the
// surviving head unions the tail's entire handle-set into its aliases, so it
// answers to both and every existing ref to the tail still resolves with zero
// referrer rewriting. head.ID stays primary; tail's id + aliases join
// head.Aliases (deduped, head.ID excluded). Returns a fresh block without
// mutating either input, so undo can restore the exact prior assignment.
func mergeHandles(head, tail SieveBlock) SieveBlock {
	seen := map[string]bool{}
	var aliases []string
	add := func(h string) {
		if h == "" || h == head.ID || seen[h] {
			return
		}
		seen[h] = true
		aliases = append(aliases, h)
	}
	for _, a := range head.Aliases {
		add(a)
	}
	add(tail.ID)
	for _, a := range tail.Aliases {
		add(a)
	}
	head.Aliases = aliases
	return head
}

// (prose serialization now lives on ProseProcessor.Serialize — the flavour owns it)
