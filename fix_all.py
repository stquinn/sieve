import re
import glob

# web_clip_processor.go: restore uuid assignment
with open("sieve/web_clip_processor.go", "r") as f:
    content = f.read()
content = content.replace("func (p *WebClipBlockProcessor) RunJob(jctx JobContext) error {\n\tblock := jctx.Block", "func (p *WebClipBlockProcessor) RunJob(jctx JobContext) error {\n\tuuid, block := jctx.UUID, jctx.Block")
with open("sieve/web_clip_processor.go", "w") as f:
    f.write(content)

# code_processor_test.go: missed RunJob
with open("sieve/code_processor_test.go", "r") as f:
    content = f.read()
content = re.sub(
    r"p\.RunJob\(context\.Background\(\), \"[^\"]*\", ([a-zA-Z0-9_]+), nil\)",
    r'p.RunJob(JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: \1})',
    content
)
content = re.sub(
    r"p\.RunJob\(context\.Background\(\), \"[^\"]*\", &([a-zA-Z0-9_]+), nil\)",
    r'p.RunJob(JobContext{Ctx: context.Background(), UUID: "test-uuid", Block: &\1})',
    content
)
with open("sieve/code_processor_test.go", "w") as f:
    f.write(content)

# editor_service_test.go: update testRunJobProcessor signature
with open("sieve/editor_service_test.go", "r") as f:
    content = f.read()
content = content.replace("func (m *testRunJobProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {", "func (m *testRunJobProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {")
content = content.replace("func (m *testRunJobProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error {", "func (m *testRunJobProcessor) RunJob(jctx JobContext) error {\n\tblock, notify := jctx.Block, jctx.Notify")

with open("sieve/editor_service_test.go", "w") as f:
    f.write(content)

# markdown_parser_test.go: add imports
with open("sieve/markdown_parser_test.go", "r") as f:
    content = f.read()
if '"strings"' not in content:
    content = content.replace('import (\n\t"testing"', 'import (\n\t"testing"\n\t"strings"')
with open("sieve/markdown_parser_test.go", "w") as f:
    f.write(content)

