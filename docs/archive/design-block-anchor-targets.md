# Block Anchor: Target Highlighting Extension

## Context

Block Anchors (`[!block] id="..." ... [!block-end]`) mark a region of the document as the focal scope for an AI chain. The `ContextProvider` uses the anchor's content as the context when building AI prompts.

This document describes an extension to that model: **precision targets** — the ability to mark specific words or phrases within a block as the precise subject of the question, not just the surrounding context.

**Related documents:**
- `docs/plan-block-anchors.md` — Goldmark implementation of BlockAnchorNode
- `docs/design-block-lifecycle.md` — broader block lifecycle, Convert to Markdown, chain synthesis

---

## Core Product Decision: Highlight Means AI Attention

In Sieve, **highlight (`==word==`) has one meaning: direct AI attention to this word or phrase.**

It is not a general formatting tool. General emphasis is served by bold and underline, which remain available in the editor toolbar. Highlight does not appear in the toolbar — it is only accessible through the right-click context menu as a deliberate AI-targeting action.

This eliminates any ambiguity between "I highlighted this for emphasis" and "I highlighted this as an AI target." Within Sieve, if a word is highlighted, it was highlighted to direct AI attention. There is no other way to create a highlight through normal editor use.

Outside Sieve, `==word==` reads as emphasis in any markdown viewer — semantically correct for content the user considered important enough to ask an AI about.

---

## The Problem

A block anchor wraps a paragraph, sentence, or section. The whole content becomes the AI's context. This is sufficient for questions about a section, but loses precision for questions about a specific word or phrase within it.

Without targeting, asking "define this" about "acute" in:

```
The patient showed acute symptoms with rapid onset progression.
```

gives the AI the whole sentence as context with no signal about which part matters. The AI must guess the focus.

---

## The Solution: `==` Precision Markers

Standard markdown highlight syntax marks the precise target within block content:

```
[!block] id="blk-1234"

The patient showed ==acute== symptoms with ==rapid onset== progression.

[!block-end]
```

The `ContextProvider` extracts both:

- **Context** — the full block content (the paragraph, table cell, section)
- **Targets** — all text ranges wrapped in `==...==`

The AI prompt becomes:

> Given this context: *"The patient showed acute symptoms with rapid onset progression."*  
> Specifically regarding: *"acute"*, *"rapid onset"*

Multiple targets per block are supported. Each `==` pair is a separate precision point. Targets are additive — the user can highlight more words after the fact to sharpen the question before running it.

---

## Interaction Design: Two Paths to a Highlight

### Path 1 — Explicit: Right-click → Highlight

The user deliberately tags words or a region for future AI attention. Useful for pre-marking multiple targets across a block before running a single question against all of them.

### Path 2 — Implicit: Select text → run any AI action

The more natural path. The user selects text and runs an AI action (Ask, Explain, etc.). As a side effect the selection is automatically wrapped in `==` and a BlockAnchor is created if one doesn't exist. The highlight is the system recording what was targeted — it appears as confirmation, not as a prerequisite.

On replay, the highlight is already in place and the context is already precise. No extra step required.

---

Both paths produce the same result. The behaviour in each case:

| Selection | Already in a BlockAnchor? | Result |
|---|---|---|
| Whole paragraph / node | No | Wrap in BlockAnchor — no `==` needed, the block is the target |
| Whole paragraph / node | Yes | No-op — block already defines the entire target |
| Word or phrase | No | Wrap parent paragraph in BlockAnchor AND mark selection with `==` |
| Word or phrase | Yes | Mark selection with `==` only |

When the selection spans the entire block content, no `==` mark is needed — the BlockAnchor itself is the highlight. A `==` mark only adds value when the target is a subset of the block content. The rule *"sub-element selected, no existing block"* auto-wraps the parent — no prompt, no ambiguity.

**Detecting whole-node selection (discounting whitespace):** In the context menu action handler, compare the trimmed selected text against the trimmed node content using ProseMirror's `textBetween`:

```javascript
const { from, to, $from } = state.selection
const nodeStart = $from.start($from.depth)
const nodeEnd   = $from.end($from.depth)

const coversNode =
  state.doc.textBetween(from, to).trim() ===
  state.doc.textBetween(nodeStart, nodeEnd).trim()
```

If `coversNode` is true, wrap in BlockAnchor only — no `==` applied.

---

## TipTap Rendering

### Why a Mark, Not Raw Characters

This distinction matters. There are two ways `==` could be implemented:

1. **Raw characters injected into the text** — `==` becomes literal editable characters sitting next to the word in the document. Delete the word but not the delimiters and you get orphaned `====` stranded in the document.

2. **A TipTap mark** — a mark is an *attribute* of a text range, not a character in the text. It lives on the word, not beside it. The `==` delimiters only exist in the serialised markdown output. Inside TipTap's document model there are no delimiter characters at all.

The mark approach means correct behaviour is automatic:

| User action | Result |
|---|---|
| Delete the marked word | Mark disappears with the text — no orphaned delimiters |
| Edit the word | Mark extends to cover the changed text |
| Select across the mark boundary and delete | Everything gone cleanly |

This is the same mechanism TipTap uses for bold, italic, and links. Deleting a bold word doesn't leave `**` stranded in the document — because bold is a mark, not characters. Target highlighting works the same way.

### Implementation

Add `T.Highlight` to the TipTap extensions for rendering. Do **not** add it to the formatting toolbar — highlight is not a user formatting tool. The only UI entry point is the right-click Highlight action.

### Visual Language

Two visual states to design:

- **Chain present but not focused** — highlighted words carry a subtle persistent indicator (dotted underline or similar) so they are always visible as AI-targeted
- **Chain active / focused** — highlighted words rendered more prominently in the chain's visual language, consistent with the left-bracket chain indicator

---

## ContextProvider Integration

> **Implementation note:** Target extraction from BlockAnchors is to be implemented when ContextProviders are built. The `==` mark and the Highlight context menu action can ship independently — they produce valid markdown from day one. The ContextProvider reads and acts on that markdown when it exists.

When building the AI prompt for a chain whose `ref` points to a BlockAnchor:

1. Extract full block content (strip `==` delimiters, keep text)
2. Extract all `==target==` ranges as an ordered list
3. If targets present: prompt includes both context paragraph and targets list
4. If no targets: prompt includes context only (existing behaviour, unchanged)

---

## Replay Semantics

Both the context and targets are **live** — they reflect the current document state, not a frozen snapshot.

- Edit a word inside `==` markers → next replay uses the updated word
- Delete a target word → `==` markers leave with it → next replay has that target removed → correct
- Delete the whole paragraph → BlockAnchor leaves with it → next replay has no context → correct

This is intentional. Replay means *"ask this question again about what is there now."* The write → review → revise → replay cycle depends on context being live, not frozen.

---

## What This Is Not

This is not a replacement for the stored-context approach on AI blocks. That remains valid for **quick unscoped questions** — where the user asks something without explicitly selecting a region. The two mechanisms coexist:

| Use case | Mechanism |
|---|---|
| Quick question, no selection | `context` + `target` attrs stored in AI block YAML (snapshot) |
| Deliberate scoped question | BlockAnchor + `==highlight==` (live reference) |
| Question about a SieveBlock | `ref=` pointing to SieveBlock's stable ID |
