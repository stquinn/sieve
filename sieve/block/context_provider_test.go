package block

import (
	"testing"

	"sieve/sieve/domain"
)

type mockContextProcessor struct {
	FencedSerializer
	FencedDeserializer
	returnVal string
	buildFn   func(domain.SieveBlock) string
}

func (m *mockContextProcessor) Kind() string { return m.FencedDeserializer.Kind }

func (m *mockContextProcessor) BuildContext(block domain.SieveBlock, doc DocView, seen map[string]bool) AIContext {
	if m.buildFn != nil {
		return AIContext{Content: m.buildFn(block)}
	}
	return AIContext{Content: m.returnVal}
}
func (m *mockContextProcessor) MarkdownRepresentation(_ domain.SieveBlock, _ string) string {
	return ""
}
func (m *mockContextProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (m *mockContextProcessor) IsSupportedContent(entries []ContentEntry) SupportedActions {
	return SupportedActions{}
}
func (m *mockContextProcessor) Transform(entries []ContentEntry, uuid, blockID string, action Action) map[string]interface{} {
	return nil
}
func (m *mockContextProcessor) DescribeJob(_ JobContext) *ProcessorJob { return nil }
func (m *mockContextProcessor) OnChange(_ *domain.SieveBlock)          {}
func (m *mockContextProcessor) Mode() BlockMode                        { return BlockModeBlock }

func TestGetContextProviderFallsBackToProcessor(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "test-cp-kind"}, returnVal: "from-processor"})
	cp := GetContextProvider("test-cp-kind")
	if cp == nil {
		t.Fatal("expected ContextProvider, got nil")
	}
	result := cp.BuildContext(domain.SieveBlock{ID: "x", Kind: "test-cp-kind"}, DocView{}, map[string]bool{})
	if result.String() != "from-processor" {
		t.Errorf("expected 'from-processor', got %q", result)
	}
}

func TestGetContextProviderUsesRegisteredOverride(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "test-override-kind"}, returnVal: "from-processor"})
	RegisterContextProvider("test-override-kind", &mockContextProcessor{returnVal: "from-override"})
	cp := GetContextProvider("test-override-kind")
	if cp == nil {
		t.Fatal("expected ContextProvider, got nil")
	}
	result := cp.BuildContext(domain.SieveBlock{ID: "y", Kind: "test-override-kind"}, DocView{}, map[string]bool{})
	if result.String() != "from-override" {
		t.Errorf("expected 'from-override', got %q", result)
	}
}

func TestGetContextProviderReturnsNilForUnknownKind(t *testing.T) {
	if cp := GetContextProvider("definitely-not-registered-xyz"); cp != nil {
		t.Error("expected nil for unregistered kind")
	}
}
