package sieve

import (
	"regexp"
	"strings"
)

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

// handleMarkerRe matches a Sieve handle marker on its own line. The `s:`
// sentinel namespace distinguishes it from a user-authored HTML comment.
var handleMarkerRe = regexp.MustCompile(`^\s*<!--s:([\w-]+)-->\s*$`)

// handleAt pairs a stripped handle with the byte offset, in the cleaned
// markdown, of the block it labels (the block immediately below the marker).
type handleAt struct {
	handle string
	offset int
}

// stripHandles removes handle-marker lines from markdown and returns the clean
// markdown plus, for each marker, the handle and the offset of the block below
// it. A marker binds to the next non-marker line; if that line is blank
// (external edit dropped the pairing) the handle simply fails to match a block
// later and is treated as a new block — degraded mode, per spec §13.
func stripHandles(markdown string) (string, []handleAt) {
	lines := strings.Split(markdown, "\n")
	var clean strings.Builder
	var handles []handleAt
	var pending []string

	for i, ln := range lines {
		if m := handleMarkerRe.FindStringSubmatch(ln); m != nil {
			pending = append(pending, m[1])
			continue // drop the marker line entirely
		}
		if len(pending) > 0 {
			off := clean.Len() // start of this (the labelled) block in clean
			for _, h := range pending {
				handles = append(handles, handleAt{handle: h, offset: off})
			}
			pending = nil
		}
		clean.WriteString(ln)
		if i < len(lines)-1 {
			clean.WriteString("\n")
		}
	}
	return clean.String(), handles
}

// ParseBlockDocWithHandles is the handle-aware loader: it strips markers, parses
// the clean markdown into an ordered BlockDoc, then assigns each stripped handle
// to the prose block whose content begins at the marker's offset.
func ParseBlockDocWithHandles(markdown string) (BlockDoc, error) {
	clean, handles := stripHandles(markdown)
	spans, err := segmentBlockDoc(clean)
	if err != nil {
		return BlockDoc{}, err
	}
	for _, h := range handles {
		for i := range spans {
			if spans[i].block.Kind == KindProse && spans[i].start == h.offset {
				spans[i].block.ID = h.handle
				break
			}
		}
	}
	doc := BlockDoc{Blocks: make([]DocBlock, len(spans))}
	for i, s := range spans {
		doc.Blocks[i] = s.block
	}
	return doc, nil
}

// splitHandles applies the split handle rule (Enter mid-block, spec §7): the
// head keeps ALL its handles unchanged; the tail mints exactly one fresh handle
// and answers to nothing else. Undoing a split therefore just discards the tail
// — the head was never touched, so no stray handle remains. Content assignment
// is the caller's concern; this governs identity only.
func splitHandles(head DocBlock) (DocBlock, DocBlock) {
	tail := DocBlock{ID: GenerateBlockID(KindProse), Kind: KindProse}
	return head, tail
}

// mergeHandles applies the merge handle rule (Backspace at start, spec §7): the
// surviving head unions the tail's entire handle-set into its aliases, so it
// answers to both and every existing ref to the tail still resolves with zero
// referrer rewriting. head.ID stays primary; tail's id + aliases join
// head.Aliases (deduped, head.ID excluded). Returns a fresh block without
// mutating either input, so undo can restore the exact prior assignment.
func mergeHandles(head, tail DocBlock) DocBlock {
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

// SerializeBlockDocWithHandles is the handle-aware writer (the `attachHandles`
// role from the plan): it serializes the block tree, re-prepending a marker
// line above every prose block that carries an ID. Fenced blocks already
// persist their handle in the YAML `id:` field, so they are unchanged.
func SerializeBlockDocWithHandles(doc BlockDoc) (string, error) {
	parts := make([]string, 0, len(doc.Blocks))
	for _, b := range doc.Blocks {
		if b.Kind == KindProse {
			content := b.Content
			if b.ID != "" {
				content = "<!--s:" + b.ID + "-->\n" + content
			}
			parts = append(parts, content)
			continue
		}
		s, err := serializeFencedBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}
