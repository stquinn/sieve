package block

// fakeProc is a minimal block-mode processor for tests that only need a kind
// registered for the parse gate (the parser/codec treats a fenced kind as a
// structured block only if a block-mode processor is registered for it). It
// serializes through the shared fenced machinery, so round-trips are real.
type fakeProc struct {
	FencedSerializer
	FencedDeserializer
}

func newFakeProc(kind string) *fakeProc {
	return &fakeProc{FencedDeserializer: FencedDeserializer{Kind: kind}}
}

func (p fakeProc) Kind() string { return p.FencedDeserializer.Kind }
func (fakeProc) InitAttrs(id string, o map[string]interface{}) map[string]interface{} {
	if o == nil {
		o = map[string]interface{}{}
	}
	o["id"] = id
	return o
}
func (fakeProc) IsSupportedContent([]ContentEntry) SupportedActions          { return SupportedActions{} }
func (fakeProc) Transform([]ContentEntry, string, string, Action) map[string]any { return nil }
func (fakeProc) RunJob(JobContext) error                                     { return nil }
func (fakeProc) JobLabel(*SieveBlock) string                                 { return "" }
func (fakeProc) OnChange(*SieveBlock)                                        {}
func (fakeProc) Mode() BlockMode                                             { return BlockModeBlock }
func (fakeProc) BuildContext(SieveBlock, DocView, map[string]bool) AIContext { return AIContext{} }
func (fakeProc) MarkdownRepresentation(SieveBlock, string) string { return "" }
