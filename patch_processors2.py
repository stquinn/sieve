import re
import glob

for filename in glob.glob("sieve/*_processor.go"):
    with open(filename, "r") as f:
        content = f.read()
    
    # RunJob patch
    content = re.sub(
        r"func \(p \*([a-zA-Z]+Processor)\) RunJob\(ctx context\.Context, uuid string, block \*SieveBlock, [a-zA-Z_]+ func\(.*?\)\) error \{",
        r"func (p *\1) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify\n\t_ = notify",
        content
    )
    
    # BuildContext patch
    content = re.sub(
        r"func \(p \*([a-zA-Z]+Processor)\) BuildContext\(([a-zA-Z_]+) SieveBlock, ([a-zA-Z_]+) ShadowDocument\) string \{",
        r"func (p *\1) BuildContext(\2 SieveBlock, \3 ShadowDocument, seen map[string]bool) string {",
        content
    )

    with open(filename, "w") as f:
        f.write(content)

