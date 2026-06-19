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
		b.Content = op.Content
		if op.Attrs != nil {
			b.Attrs = op.Attrs
		}
		if op.Aliases != nil {
			b.Aliases = op.Aliases
		}
		return nil

	case "create-block":
		// A block can never enter the tree without an id. The frontend mints
		// client-side and supplies one; if it doesn't, the constructor generates
		// one here (given an id or generate one) rather than admitting an id-less
		// block. GenerateBlockIDFor honors a registered processor's prefix.
		id := op.BlockID
		if id == "" {
			id = GenerateBlockIDFor(op.Kind)
		}
		nb := DocBlock{
			ID:      id,
			Kind:    op.Kind,
			Content: op.Content,
			Attrs:   op.Attrs,
			Aliases: op.Aliases,
		}
		target := &d.Blocks
		if op.ParentID != "" {
			parent := d.findBlock(op.ParentID)
			if parent == nil {
				return fmt.Errorf("create-block: parent %q not found", op.ParentID)
			}
			target = &parent.Children
		}
		insertBlockAt(target, op.Index, nb)
		return nil

	case "delete-block":
		if _, ok := removeBlock(&d.Blocks, op.BlockID); !ok {
			return fmt.Errorf("delete-block: block %q not found", op.BlockID)
		}
		return nil

	case "move", "reorder":
		removed, ok := removeBlock(&d.Blocks, op.BlockID)
		if !ok {
			return fmt.Errorf("move: block %q not found", op.BlockID)
		}
		target := &d.Blocks
		if op.ParentID != "" {
			parent := d.findBlock(op.ParentID)
			if parent == nil {
				return fmt.Errorf("move: parent %q not found", op.ParentID)
			}
			target = &parent.Children
		}
		insertBlockAt(target, op.Index, removed)
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
		if r, ok := removeBlock(&(*blocks)[i].Children, id); ok {
			return r, true
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
		if found := findBlockIn(blocks[i].Children, id); found != nil {
			return found
		}
	}
	return nil
}
