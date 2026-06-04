import sys

with open("sieve/editor_service.go", "r") as f:
    content = f.read()

old_runjob_setup = """	shadow.mu.Lock()
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.Unlock()
		return
	}
	kind := blk.Kind
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	attrsBefore := make(map[string]interface{}, len(blk.Attrs))
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
		attrsBefore[k] = v
	}
	shadow.mu.Unlock()"""

new_runjob_setup = """	shadow.mu.Lock()
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.Unlock()
		return
	}
	kind := blk.Kind
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	attrsBefore := make(map[string]interface{}, len(blk.Attrs))
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
		attrsBefore[k] = v
	}
	markdown := shadow.Markdown
	mode := shadow.Mode
	blocksCopy := make(map[string]*SieveBlock, len(shadow.Blocks))
	for k, v := range shadow.Blocks {
		blocksCopy[k] = v
	}
	shadow.mu.Unlock()"""

content = content.replace(old_runjob_setup, new_runjob_setup)

old_runjob_call = """	if err := processor.RunJob(ctx, uuid, blkCopy, notify); err != nil {"""
new_runjob_call = """	jctx := JobContext{
		Ctx:    ctx,
		UUID:   uuid,
		Shadow: ShadowDocument{UUID: uuid, Markdown: markdown, Mode: mode, Blocks: blocksCopy},
		Block:  blkCopy,
		Notify: notify,
	}
	if err := processor.RunJob(jctx); err != nil {"""

content = content.replace(old_runjob_call, new_runjob_call)

with open("sieve/editor_service.go", "w") as f:
    f.write(content)
