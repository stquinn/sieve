# AIContext: structured block context + collection merge — Design

**Date:** 2026-06-20
**Status:** Proposed (brainstormed; pending plan)
**Motivates:** multi-target AI prompt legibility (a node-id reference in a THREAD entry could not be mapped to unlabelled TARGET content) + a reusable framework primitive for "build context for a collection (a MANY)".

---

## 1. Problem

`ContextProvider.BuildContext(block, doc, seen) string` answers *"represent ONE block as AI context."* There is no primitive for *"represent a COLLECTION coherently."* The AI ref-chain resolver (`AIBlockProcessor.RunJob`) reaches a **terminal MANY** of target blocks (a multi-block selection) and must compose them into one TARGET section. Composing a collection is not concatenation, because aspects compose differently:

- **content** is **per-member** (each block's text);
- **node id** is **per-member** but **plural** after merge (the collection has several);
- **focus** ("Specifically regarding") is a **trailer** that **aggregates** across the collection.

Because `BuildContext` returns a flat pre-formatted string that *bundles* content + the focus trailer, a collection can only string-concatenate — yielding N repeated `Specifically regarding:` lines. That degrades prompt legibility (observed: an LLM could not map a THREAD entry's `QUESTION ABOUT: pr-c2dc,pr-e51a,pr-f405` to the TARGET, because the target content carried no node ids).

## 2. Principle

A block returns **structured context data**, not a pre-rendered string. **Merge** and **render** become explicit framework operations. A single block is just a **collection of one**, so there is no special case: `BuildContext` always yields a list-of-one `AIContext`, and `merge` is the identity on a single element.

Every operation is uniform and never fuses atoms:
- `NodeIDs` → **slice concat**
- `Content` → string append (joined by a blank line)
- each `Tag.Values` → **slice concat** (union, deduped), keyed by `Label`

No kind inspection anywhere; mixed-type collections merge blind.

## 3. Types

```go
// Tag is a trailer aspect of a block's AI representation. Values are atomic and
// stay separate across a merge (array concat, never string concat), so the model
// sees distinct items and is never told two independent foci are one phrase.
type Tag struct {
    Label  string
    Values []string
}

// AIContext is the structured AI representation of one or more blocks. NodeIDs is
// a member field (a header), plural because a merged context spans several nodes;
// Content is the per-member body text appended on merge; Tags are mergeable
// trailers. A single block is an AIContext with a one-element NodeIDs.
type AIContext struct {
    NodeIDs []string
    Content string
    Tags    []Tag
}
```

## 4. Operations

### merge (collection → one)
`merge(cs ...AIContext) AIContext` (or `merge([]AIContext)`):
- `NodeIDs` = concat of all `cs[i].NodeIDs`
- `Content` = `strings.Join(non-empty cs[i].Content, "\n\n")`
- `Tags` = union by `Label`; for a shared label, `Values` = concat then dedup (stable order)

`merge` of one element returns it unchanged. Pure, total, table-testable.

### String (render)
`(AIContext).String() string`:
```
NODE ID: <strings.Join(NodeIDs, ",")>
<Content>

<for each Tag, in order:>  <Label>: "v1", "v2", …
```
(Header omitted if `NodeIDs` empty; trailer block omitted if no tags. The exact blank-line layout is pinned by tests.)

## 5. Per-processor migration

`ContextProvider.BuildContext` and `block.BuildContextForID` change return type `string → AIContext`. Most processors are a one-line wrap:

- **ProseProcessor** — `AIContext{ NodeIDs: []string{blk.ID}, Content: blk.Content(), Tags: focusTags(blk.Content()) }`. The `==marks==` extraction (`extractTargets`/`targetHighlightRe`) moves out of the bundled string into a `Tags` entry `{"Specifically regarding", …}`. **The focus line is no longer appended in `BuildContext`** — `String()`/merge render it.
- **AIBlockProcessor** — `NodeIDs: []string{blk.ID}`, `Tags: [{"QUESTION ABOUT"/"EXPLAIN NODE", [ref]}]`, `Content` = question + `**ANSWER:**` response. (Its current bespoke header/trailer string becomes structured fields; same rendered output.)
- **Fenced/structured kinds** (code/diagram/log/smart-*/web-clip) — `AIContext{ NodeIDs: []string{blk.ID}, Content: <existing context text> }`, no tags (unless a kind wants its own trailer later — the slice is open).
- `id == "doc"` — `AIContext{ Content: deriveMarkdown() }` (no node id header; "doc" is the whole document).

`BuildContextForID` returns the empty `AIContext{}` for a not-found / empty block (callers drop it, as today on `""`).

## 6. Consumer: AIBlockProcessor.RunJob

```
targets, threadIDs := resolveChain(...)            // unchanged geometric walk
targetCtx := merge(contextForEach(targets)...)     // ONE AIContext (the MANY)
TARGET    := targetCtx.String()
THREAD    := join(each contextForID(threadID).String(), "\n\n---\n\n")  // distinct entries, NOT merged
ACTION    := contextForID(actionBlock).String()    // i.e. p.BuildContext(*blk).String()
```

`merge` is reserved for the MANY (the target). Thread entries are distinct Q&A and are rendered individually and joined — they are not unioned (each keeps its own trailer). This yields, for the target:

```
NODE ID: pr-c2dc,pr-e51a,pr-f405
This ==is some text==

==Some== more text

Specifically regarding: "is some text", "some"
```

— the id list now matches the THREAD's `QUESTION ABOUT` ids, so the model can map the reference. Legibility fix falls out of the merge.

## 7. Scope discipline

`AIContext` carries exactly `{NodeIDs, Content, Tags}`. No speculative fields — the open `Tags` slice absorbs any future trailer (a kind that needs different context just emits its own `Tag`) without a type change. `merge` never inspects kind. `BuildContext`/`BuildContextForID` keep their call sites and `seen` semantics; only the return type changes.

## 8. Testing strategy

White-box in `block/` (the type + merge/String are framework) and `block/processors/` (the real ProseProcessor/AIBlockProcessor):
1. `merge`: concat NodeIDs; append Content; union Tags by label with dedup; merge-of-one is identity; empty contents dropped.
2. `String`: header from NodeIDs join; tag rendering `Label: "a", "b"`; header/trailer omitted when empty.
3. ProseProcessor.BuildContext → AIContext with focus in `Tags`, content with inline `==marks==`, no appended focus line.
4. AIBlockProcessor.BuildContext → structured NodeIDs/Tags/Content, same rendered output as before.
5. RunJob end-to-end (the existing `resolveChain` tests stay): multi-block selection target renders one node-id header + one merged `Specifically regarding`; deep chain target is the terminal MANY.

## 9. Out of scope / fold-in

- Two outstanding final-review fixes ride along in the same branch: the stale `ProseProcessor.Accepts` doc-comment (still describing the deleted coalescing), and the dead `shapeParseState.start` field.
- No frontend change (refs already point-to-point).
- Per-member node-id headers (one `NODE ID:` per block rather than a combined list) were considered and rejected: the merged-into-one model is more uniform and the combined id list is sufficient to resolve THREAD references.
