package sieve

import (
	"fmt"
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

// markerOpenRe / markerCloseRe match the paired comment-tag delimiters that
// bound every block (spec §"Storage format: a comment-tag block tree"). The open
// marker's capture is a SPACE-SEPARATED handle list: the first token is the
// block's primary ID, any remaining tokens are aliases it also answers to
// (post-merge handle-set, spec §7). The close marker carries the primary ID
// only. The `s:` sentinel namespace distinguishes these from user HTML comments.
var (
	markerOpenRe  = regexp.MustCompile(`^\s*<!--s:([\w-]+(?:\s+[\w-]+)*)\s*-->\s*$`)
	markerCloseRe = regexp.MustCompile(`^\s*<!--/s:([\w-]+)\s*-->\s*$`)
)

// ParseBlockDocWithHandles is the handle-aware loader. Structure derives ONLY
// from delimiters: top-level structured fences (atomic, opaque) and paired
// `<!--s:ID--> … <!--/s:ID-->` prose blocks. Unbalanced opens are literal text;
// undelimited runs become a single opaque prose block. Blank lines never split.
func ParseBlockDocWithHandles(markdown string) ([]DocBlock, error) {
	return scanBlocks(markdown), nil
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

// SerializeBlockDocWithHandles is the handle-aware writer: it serializes the
// block tree with paired comment-tag delimiters (spec §"Storage format"). A
// prose block carrying an ID is wrapped `<!--s:ID alias…-->\n<content>\n
// <!--/s:ID-->`; the open marker lists the full handle-set, the close the
// primary id only. Handle-less prose (not yet minted) emits bare content.
// Fenced blocks already persist their handle in the YAML `id:` field and stay
// self-delimiting, so they are unchanged.
func SerializeBlockDocWithHandles(blocks []DocBlock) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		// Persistence-boundary guard (the runtime teeth behind newDocBlock): a
		// block must never reach disk id-less. If this fires, a code path built a
		// block via a raw literal instead of the factory — fix the construction
		// site, don't relax the guard.
		if b.ID == "" {
			return "", fmt.Errorf("refusing to persist id-less %s block (construct via newDocBlock)", b.Kind)
		}
		if b.Kind == KindProse {
			parts = append(parts, serializeProseBlock(b))
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

// serializeProseBlock wraps a prose block in its paired comment-tag delimiters.
// Handle-less prose (empty ID — undelimited, pre-mint) is emitted verbatim so
// the handle-less spine and minting-on-Open stay decoupled.
func serializeProseBlock(b DocBlock) string {
	if b.ID == "" {
		return b.Content()
	}
	handles := append([]string{b.ID}, b.Aliases...)
	open := "<!--s:" + strings.Join(handles, " ") + "-->"
	closeTag := "<!--/s:" + b.ID + "-->"
	return open + "\n" + b.Content() + "\n" + closeTag
}
