package block

// ProcessorJob is the block-level descriptor a processor returns (by pointer)
// from DescribeJob. The framework owns the lifecycle; a processor writes no
// tracking/finish code. A DescribeJob that returns nil means "no async work" —
// a *ProcessorJob is ONLY ever returned for real async work, so a returned job
// always has a non-empty Label and a non-nil Work (the framework asserts the
// Label on submit). "No async work" blocks settle to COMPLETE at creation
// (InitAttrs), never through a job.
type ProcessorJob struct {
	Category string                            // producer-owned category, e.g. CategoryAI
	Label    string                            // status-bar label — MUST be non-empty for a returned job
	Work     func() (any, error)               // the blocking backend call (e.g. an AI CLI)
	Apply    func(result any, blk *SieveBlock) // mutate blk.Attrs from Work's result
}

// CategoryAI is the engine category for AI (claude CLI) work. It is
// producer-owned opaque data — defined here, beside ProcessorJob, because the
// submitters (block/processors and editor) both import block. The ai package is
// deliberately ignorant of categories and the engine. Future categories
// (exec/http/dag) live beside their own producers.
const CategoryAI = "ai"

// CategoryDefault is the explicit category for non-AI block jobs (link/log fetch).
// Every ProcessorJob that will be submitted DECLARES its category — a job that
// runs on the default pool must say "default" rather than leaning on the engine's
// empty-string fallback. The "no job" case returns a nil *ProcessorJob, which is
// never submitted and carries no category.
const CategoryDefault = "default"
