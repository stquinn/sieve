package block

import (
	"fmt"

	"sieve/sieve/fencedblock"

	"gopkg.in/yaml.v3"
)

// ColumnRow is the in-memory shadow representation of a `column-row` container
// block (spec §6/§7). It serializes to a Shape-1 YAML fence body: `id`, an
// optional `widths` ratio array, and a `columns` list. Each column holds an
// ordered list of children, where a child is either verbatim markdown prose
// (a YAML string scalar) or a nested Sieve block (a single-key map: kind →
// attrs). The fence wrapping (```column-row … ```) is applied by the caller.
type ColumnRow struct {
	ID      string    `yaml:"id"`
	Widths  []float64 `yaml:"widths,omitempty"`
	Columns []Column  `yaml:"columns"`
}

// Column is one cell of a ColumnRow: an ordered list of block children.
type Column struct {
	Children []Child `yaml:"children"`
}

// Child is the discriminated union of a column's content (spec §7): exactly one
// of Prose / Block is set. A string scalar in YAML is Prose (verbatim markdown,
// no "prose kind"); a single-key map is a Block (the key is the kind, the value
// is its attrs — the 1:1 translation of a standalone fence).
type Child struct {
	Prose string
	Block *SieveBlock
}

// MarshalYAML performs the Shape-1 "lift": a block child becomes {kind: attrs};
// a prose child becomes a plain string scalar.
func (c Child) MarshalYAML() (interface{}, error) {
	if c.Block != nil {
		return map[string]interface{}{c.Block.Kind: c.Block.Attrs}, nil
	}
	return c.Prose, nil
}

// UnmarshalYAML performs the Shape-1 "lower": a scalar node is prose; a mapping
// node is a single-key block map (key → kind, value → attrs).
func (c *Child) UnmarshalYAML(value *yaml.Node) error {
	switch value.Kind {
	case yaml.ScalarNode:
		return value.Decode(&c.Prose)
	case yaml.MappingNode:
		var m map[string]map[string]interface{}
		if err := value.Decode(&m); err != nil {
			return err
		}
		if len(m) != 1 {
			return fmt.Errorf("columnrow: block child must be a single-key map, got %d keys", len(m))
		}
		for kind, attrs := range m {
			blk := &SieveBlock{Kind: kind, Attrs: attrs}
			if id, ok := attrs["id"].(string); ok {
				blk.ID = id
			}
			c.Block = blk
		}
		return nil
	default:
		return fmt.Errorf("columnrow: unexpected child node kind %d", value.Kind)
	}
}

// SerializeColumnRow encodes a ColumnRow as a fence body using the shared
// fencedblock machinery, so multiline prose and nested block scalars inherit
// the literal-style (|) + 4-space-indent guarantees (inner-fence safety).
func SerializeColumnRow(cr ColumnRow) (string, error) {
	return fencedblock.SerializeYaml(cr)
}

// ParseColumnRow decodes a fence body back into a ColumnRow.
func ParseColumnRow(fenceBody string) (ColumnRow, error) {
	var cr ColumnRow
	if err := yaml.Unmarshal([]byte(fenceBody), &cr); err != nil {
		return ColumnRow{}, fmt.Errorf("columnrow: parse: %w", err)
	}
	return cr, nil
}
