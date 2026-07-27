# Inline block removal — links are special, but not Sieve blocks

**Status:** Designed
**Tracked:** #67
**Date:** 2026-07-27

## Problem

`smart-link` is the last inhabitant of `BlockModeInline` — the one Sieve "block"
that lives *inside* prose rather than as a member of the document list. It is
badly broken in four visible ways (#67): it renders only after a reload, it
interplays poorly with the rest of the editor, it disappears, and Extract/Embed
do nothing.

All four share one root cause: **Go writes the inline marker and never reads it
back; the frontend reads it and never writes it.** The two halves are exactly
inverted, so content is lost in both directions.

| | Go | Frontend |
|---|---|---|
| Write `[!smart-link]{…}[!smart-link-end]` | yes — `InlineSerializer.Serialize` | never — the inline node's markdown serializer is a **no-op** (`if (!cfg.inline) state.closeBlock(node)`, `sieve-block-extension.js:911-913`) |
| Read it back | never — `InlineDeserializer.Accepts()` → `false` (`processor_registry.go:404`) | yes — the markdown-it inline ruler (`sieve-block-extension.js:921`) |

From that asymmetry, each symptom follows:

1. **Renders only after reload.** The create render-back places the server's
   authoritative node at a *top-level block index*
   (`docPosForBlockIndex`, `surfaces/block-position.js:22`). An inline node has no
   top-level index, so it cannot land inside the paragraph it was pasted into. It
   appears only when the markdown-it ruler re-parses the raw text on load.
2. **Interplays badly.** Chrome, selection, block anchors, the interaction policy
   and Extract/Embed are all defined over top-level blocks. Inline sits outside
   every one of those coordinate systems.
3. **Disappears.** Not random — deterministic loss. Prose syncs to Go as
   frontend-serialised markdown (`block/prose-block.js:191`), and the inline node
   serialises to nothing. The first edit to a paragraph containing a smart link
   sends Go that paragraph with the link erased, href and all.
4. **Extract/Embed do nothing.** `smart-link` declares only Paste + Transform
   (`smart_link_processor.go:63`), and after a reload Go's shadow document holds no
   block of that id to address.

Compounding it: `SmartLinkProcessor` is registered *before* `SmartCardProcessor`
(`service_provider.go:123-124`) and `FirstPasteMatch` takes the first hit — so a
pasted URL always produced the broken inline thing and never the working card.

This is the residue of the 2026-06-19 interim decision (inline ≠ block; smart-link
accepted as insert-once, fire-and-forget, degrading to a plain link on round-trip,
deferred until the child/container model). That interim state is what rotted.

## Decision

**Remove inline from the block framework.** Delete `smart-link` and the mode it
inhabits. Links remain special — they keep their one genuinely useful smart, the
title — but they are ordinary markdown, not Sieve blocks.

The rejected alternative is making inline first-class. That requires Go to own
inline structure *inside* prose: prose content stops being a verbatim markdown
blob the frontend serialises and becomes a container of id'd children synced
individually — the Stage E container model plus a rewrite of the prose sync
channel, which is the part of the system that currently works. The payoff would be
a link showing its title with an icon, which `smart-card` and `web-clip` already
deliver properly as real blocks.

This does not foreclose the north star (`brainstorm-blocks-all-the-way-up`). When
children/containers land, an inline smart thing can return as a genuine **child**
of a prose block, on a real foundation. The present implementation would have to
be rewritten wholesale anyway.

## Architecture

### 1. Delete `smart-link` and `BlockModeInline` with it

- `sieve/block/processors/smart_link_processor.go` (+ its test)
- `frontend/src/static/editor/surfaces/node-views/smart-link-node-view.js`
- `block.BlockModeInline`, `block.InlineSerializer`, `block.InlineDeserializer`
  (`sieve/block/processor_registry.go`)
- the `cfg.inline` branches in `sieve-block-extension.js` — the inline markdown-it
  ruler and renderer rule, the `span` tag / `inline` group selection, and the
  no-op serialize path
- the registration in `sieve/service_provider.go`

`BlockModeInline` has **no other reader**: the codec (`document_codec.go:89`) and
the paste matcher (`processor_registry.go:568`) branch only on `BlockModeProse`.
So this removes a whole mode from the framework rather than leaving a stub — every
remaining processor is a genuine member of the document list.

### 2. Paste of a URL → an ordinary markdown link, title fetched in Go

Paste is already a Go round-trip. The URL branch resolves the title through
`LinkPreview.FetchTitle` (timeout-bounded) and inserts `<a href="url">Title</a>`, falling
back to the bare URL on timeout or failure.

**The fetch is synchronous** — one shot on the round-trip Go already performs. No
pending state, no in-flight node, no second render-back. Insert-then-update was
rejected: Go rewriting a prose block while the user types in it fights the block
observer's baseline diff, which is the same class of problem that made the inline
node lossy. Revisit only if the fetch latency is felt in practice.

In WYSIWYG the result is visually what the inline node showed, minus the icon and
the pending state.

### 3. Transform/Extract learn to recognise ordinary links

`SmartCardProcessor.IsSupportedContent` (`smart_card_processor.go:65-75`) matches
only a bare, whitespace-free `http…` string today, so selecting `[Title](https://…)`
matches nothing. Both it and the web-clip processor must extract an href from a
markdown link and from an `<a>` in an HTML paste.

That is the affordance #67 asks for — "select a link → transform to smart card /
web clip" — and it is what keeps links special *without* making them blocks. Per
the no-loose-functions rule, the href extraction is a method on the type that owns
it, not a package-level helper floating beside the processors.

## Migration

Not a concern (owner's call, 2026-07-27). Only a sandbox test document and one
buffer carry the legacy marker. Residual `[!smart-link]{…}[!smart-link-end]` text
reads as literal prose once the frontend ruler is gone.

## Consequences

- One block mode disappears; `BlockMode` becomes prose-or-block, and every
  registered processor is a document-list member. The framework gets smaller.
- Pasting a URL becomes deterministic: it produces a markdown link, and the
  richer forms (`smart-card`, `web-clip`) are reached by explicit Transform rather
  than by processor registration order.
- `docs/TECH-DEBT.md` X-D's parked `smart-link` renderer is resolved by deletion —
  the eighth renderer is never built.
