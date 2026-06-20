package services

import (
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// resetRegistry clears the global processor registry and restores the built-in
// prose terminal — the production baseline an editor/codec test starts from.
func resetRegistry() {
	block.ResetRegistry()
	block.RegisterProcessor(block.KindProse, &processors.ProseProcessor{})
}
