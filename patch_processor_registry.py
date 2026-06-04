import sys

with open("sieve/processor_registry.go", "r") as f:
    content = f.read()

replacement = """// JobContext is the complete input to a processor's RunJob.
// EditorService assembles it at dispatch time — processors never reach back into services.
type JobContext struct {
	Ctx    context.Context
	UUID   string
	Shadow ShadowDocument
	Block  *SieveBlock
	Notify func(blockID string, attrs map[string]interface{})
}

// BlockLifecycleListener listens to block lifecycle events from the framework.
"""

content = content.replace("// BlockLifecycleListener listens to block lifecycle events from the framework.\n", replacement)

old_interface = """type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	PasteMatch(entries []PasteEntry, uuid string, blockID string) (matched bool, overrides map[string]interface{})
	RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error
	JobLabel(block *SieveBlock) string
	OnChange(block *SieveBlock)
	Mode() BlockMode
	BuildContext(block SieveBlock, doc ShadowDocument) string
}"""

new_interface = """type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	PasteMatch(entries []PasteEntry, uuid string, blockID string) (matched bool, overrides map[string]interface{})
	RunJob(jctx JobContext) error
	JobLabel(block *SieveBlock) string
	OnChange(block *SieveBlock)
	Mode() BlockMode
	BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string
}"""

content = content.replace(old_interface, new_interface)

with open("sieve/processor_registry.go", "w") as f:
    f.write(content)
