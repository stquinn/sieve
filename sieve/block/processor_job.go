package block

// ProcessorJob is the block-level descriptor a processor returns from
// DescribeJob. The framework owns the lifecycle; a processor writes no
// tracking/finish code. Work == nil means no async work — Apply (if any) runs
// synchronously and the job finishes.
type ProcessorJob struct {
	Category string                            // producer-owned category, e.g. CategoryAI
	Label    string                            // status-bar label ("" ⇒ no tracker entry)
	Work     func() (any, error)               // the blocking backend call (e.g. an AI CLI)
	Apply    func(result any, blk *SieveBlock) // mutate blk.Attrs from Work's result
}

// CategoryAI is the engine category for AI (claude CLI) work. It is
// producer-owned opaque data — defined here, beside ProcessorJob, because the
// submitters (block/processors and editor) both import block. The ai package is
// deliberately ignorant of categories and the engine. Future categories
// (exec/http/dag) live beside their own producers.
const CategoryAI = "ai"
