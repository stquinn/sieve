import re
import glob

# 1. Fix unused vars in processors
for filename in glob.glob("sieve/*_processor.go"):
    with open(filename, "r") as f:
        content = f.read()
    
    content = content.replace("func (p *CodeBlockProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify\n\t_ = notify", "func (p *CodeBlockProcessor) RunJob(jctx JobContext) error {\n\tblock := jctx.Block")
    
    content = content.replace("func (p *WebClipBlockProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify\n\t_ = notify", "func (p *WebClipBlockProcessor) RunJob(jctx JobContext) error {\n\tblock := jctx.Block")

    content = content.replace("func (p *SmartLinkProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify\n\t_ = notify", "func (p *SmartLinkProcessor) RunJob(jctx JobContext) error {\n\tblock := jctx.Block")

    content = content.replace("func (p *SmartImageProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify\n\t_ = notify", "func (p *SmartImageProcessor) RunJob(jctx JobContext) error {\n\tuuid, block := jctx.UUID, jctx.Block")

    with open(filename, "w") as f:
        f.write(content)

# 2. Fix processor tests
for filename in glob.glob("sieve/*_processor_test.go"):
    with open(filename, "r") as f:
        content = f.read()
    
    content = re.sub(
        r"p\.RunJob\(context\.Background\(\), \"[^\"]*\", ([a-zA-Z0-9_]+), nil\)",
        r"p.RunJob(JobContext{Ctx: context.Background(), UUID: \"test-uuid\", Block: \1})",
        content
    )
    content = re.sub(
        r"p\.RunJob\(context\.Background\(\), \"[^\"]*\", &([a-zA-Z0-9_]+), nil\)",
        r"p.RunJob(JobContext{Ctx: context.Background(), UUID: \"test-uuid\", Block: &\1})",
        content
    )
    
    # Catch any others like `proc.RunJob(...)`
    content = re.sub(
        r"proc\.RunJob\(context\.Background\(\), \"[^\"]*\", ([a-zA-Z0-9_]+), nil\)",
        r"proc.RunJob(JobContext{Ctx: context.Background(), UUID: \"test-uuid\", Block: \1})",
        content
    )
    content = re.sub(
        r"proc\.RunJob\(context\.Background\(\), \"[^\"]*\", &([a-zA-Z0-9_]+), nil\)",
        r"proc.RunJob(JobContext{Ctx: context.Background(), UUID: \"test-uuid\", Block: &\1})",
        content
    )

    with open(filename, "w") as f:
        f.write(content)

# 3. Remove duplicate TestBuildContextForIDDispatchesByKind
with open("sieve/context_provider_test.go", "r") as f:
    content = f.read()
    
content = re.sub(r"func TestBuildContextForIDDispatchesByKind.*?\n}\n", "", content, flags=re.DOTALL)

with open("sieve/context_provider_test.go", "w") as f:
    f.write(content)

