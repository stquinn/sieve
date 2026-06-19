package sieve


// Stage B.2 — universal prose handles via on-disk markers.
//
// Every block carries a stable handle so the reference graph survives reopen
// (spec §3.1). Fenced blocks keep their handle in the YAML `id:` field; prose
// blocks carry it as a leading own-line HTML comment immediately above the
// block it labels:
//
//	<!--s:pr-3f9a-->
//	The gateway validates the token.
//
// The marker is processed by a deterministic strip-on-load / re-attach-on-save
// line pass that BYPASSES goldmark (the frontmatter pattern), operating only on
// prose — fenced-block interiors are never touched, so a marker pasted inside a
// code block cannot be corrupted. The id is hidden in the editor but always
// written back to disk.

// ParseBlockDocWithHandles is the handle-aware loader. Structure derives ONLY
// from delimiters: top-level structured fences (atomic, opaque) and paired
// `<!--s:ID--> … <!--/s:ID-->` prose blocks. Unbalanced opens are literal text;
// undelimited runs become a single opaque prose block. Blank lines never split.
func ParseBlockDocWithHandles(markdown string) ([]SieveBlock, error) {
	return scanBlocks(markdown), nil
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

// (prose serialization now lives on ProseProcessor.Serialize — the flavour owns it)
