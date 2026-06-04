import sys

def patch_file(filename):
    with open(filename, "r") as f:
        content = f.read()
    
    # Replace RunJob signature
    old_runjob = "func (p *CodeBlockProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(string, map[string]interface{})) error {"
    if "CodeBlockProcessor" in content:
        content = content.replace("func (p *CodeBlockProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error {", "func (p *CodeBlockProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify")
        content = content.replace("func (p *CodeBlockProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {", "func (p *CodeBlockProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {")

    if "WebClipProcessor" in content:
        content = content.replace("func (p *WebClipProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error {", "func (p *WebClipProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify")
        content = content.replace("func (p *WebClipProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {", "func (p *WebClipProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {")

    if "SmartLinkProcessor" in content:
        content = content.replace("func (p *SmartLinkProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error {", "func (p *SmartLinkProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify")
        content = content.replace("func (p *SmartLinkProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {", "func (p *SmartLinkProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {")

    if "SmartImageProcessor" in content:
        content = content.replace("func (p *SmartImageProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, notify func(blockID string, attrs map[string]interface{})) error {", "func (p *SmartImageProcessor) RunJob(jctx JobContext) error {\n\tctx, uuid, block, notify := jctx.Ctx, jctx.UUID, jctx.Block, jctx.Notify")
        content = content.replace("func (p *SmartImageProcessor) BuildContext(block SieveBlock, doc ShadowDocument) string {", "func (p *SmartImageProcessor) BuildContext(block SieveBlock, doc ShadowDocument, seen map[string]bool) string {")

    with open(filename, "w") as f:
        f.write(content)

patch_file("sieve/code_processor.go")
patch_file("sieve/web_clip_processor.go")
patch_file("sieve/smart_link_processor.go")
patch_file("sieve/smart_image_processor.go")
