package sieve

import "fmt"

// BlockOp is a granular mutation of the BlockDoc tree, carried over the wire
// (Stage C, spec §4). One op == one user-visible block change.
type BlockOp struct {
	Type     string                 `json:"type"`    // "create-block","update-block","delete-block","move"
	BlockID  string                 `json:"blockId"`
	Kind     string                 `json:"kind,omitempty"`
	Content  string                 `json:"content,omitempty"`
	Attrs    map[string]interface{} `json:"attrs,omitempty"`
	Aliases  []string               `json:"aliases,omitempty"`
	Index    int                    `json:"index"`
	ParentID string                 `json:"parentId,omitempty"`
}

// ApplyOp mutates the BlockDoc tree in place according to op. It returns an
// error (never silently no-ops) so the wire layer can surface failures.
func (d *BlockDoc) ApplyOp(op BlockOp) error {
	switch op.Type {
	case "update-block":
		b := d.findBlock(op.BlockID)
		if b == nil {
			return fmt.Errorf("update-block: block %q not found", op.BlockID)
		}
		if op.Attrs != nil {
			b.Attrs = op.Attrs
		}
		if op.Aliases != nil {
			b.Aliases = op.Aliases
		}
		// Prose carries its body in the content attr (set last so it survives an
		// attrs replacement above). Structured blocks keep their payload in Attrs
		// and never get a spurious content key.
		if b.Kind == KindProse {
			b.setContent(op.Content)
		}
		return nil

	case "create-block":
		// create-block is a construction point: route through the factory so an
		// op with no blockId gets one minted (given an id or generate one) rather
		// than admitting an id-less block. The frontend normally supplies the id.
		if op.ParentID != "" {
			return fmt.Errorf("create-block: nesting into parent %q is Stage E (no Children yet)", op.ParentID)
		}
		nb := newDocBlock(op.Kind, op.BlockID, op.Content, op.Attrs)
		nb.Aliases = op.Aliases
		insertBlockAt(&d.Blocks, op.Index, nb)
		return nil

	case "delete-block":
		if _, ok := removeBlock(&d.Blocks, op.BlockID); !ok {
			return fmt.Errorf("delete-block: block %q not found", op.BlockID)
		}
		return nil

	case "move", "reorder":
		if op.ParentID != "" {
			return fmt.Errorf("move: nesting into parent %q is Stage E (no Children yet)", op.ParentID)
		}
		removed, ok := removeBlock(&d.Blocks, op.BlockID)
		if !ok {
			return fmt.Errorf("move: block %q not found", op.BlockID)
		}
		insertBlockAt(&d.Blocks, op.Index, removed)
		return nil

	default:
		return fmt.Errorf("unknown block op type %q", op.Type)
	}
}

// removeBlock deletes the block with id from the tree rooted at *blocks,
// returning the removed block and whether it was found.
func removeBlock(blocks *[]DocBlock, id string) (DocBlock, bool) {
	for i := range *blocks {
		if (*blocks)[i].ID == id {
			removed := (*blocks)[i]
			*blocks = append((*blocks)[:i], (*blocks)[i+1:]...)
			return removed, true
		}
	}
	return DocBlock{}, false
}

// insertBlockAt inserts b at index in *blocks, clamping out-of-range indices to
// the ends (a robustness choice — the wire layer may send a stale index).
func insertBlockAt(blocks *[]DocBlock, index int, b DocBlock) {
	if index < 0 {
		index = 0
	}
	if index > len(*blocks) {
		index = len(*blocks)
	}
	*blocks = append(*blocks, DocBlock{})
	copy((*blocks)[index+1:], (*blocks)[index:])
	(*blocks)[index] = b
}

// findBlock returns a pointer to the block with the given ID anywhere in the
// tree, or nil. The pointer aliases the live tree so callers can mutate it.
func (d *BlockDoc) findBlock(id string) *DocBlock {
	return findBlockIn(d.Blocks, id)
}

func findBlockIn(blocks []DocBlock, id string) *DocBlock {
	for i := range blocks {
		if blocks[i].ID == id {
			return &blocks[i]
		}
	}
	return nil
}
