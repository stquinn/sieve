# Sieve — Product Vision

*Sieve is the new name for Stash.*

---

## Overview

Sieve is a scratchpad‑first thinking tool designed to reduce cognitive and operational overhead when working through ideas, debugging, investigations, and exploratory engineering work.

It is built around a simple observation:
most working material is temporary, but some moments of understanding are worth keeping — and deciding which is which *while you're still thinking* is unnecessary friction.

Sieve lets you work freely in untitled buffers, then applies judgment only when you are finished and close the buffer.

---

## The Problem Sieve Solves

Modern development and architecture work generates a lot of working material:

- copied numbers, notes, code blocks or identifiers
- pasted log excerpts
- screenshots discussed with colleagues
- rough pseudocode
- half‑written explanations
- AI conversations used to reason something out

None of these start life as "documents".
But many editors force you to choose between saving and naming everything, or losing potentially useful context.

In practice this leads to:

- dozens of unsaved tabs
- fear of closing buffers "just in case"
- accumulating mental clutter
- unnecessary cognitive load

Sieve was built to remove that overhead.

---

## Core Model

### 1. Untitled Buffers

All work in Sieve begins in an untitled buffer.

An untitled buffer:
- has no filename
- has no folder
- is not judged
- cannot be discarded while open

It is a safe workspace for scratch thinking. You can paste anything into it and freely iterate.

### 2. Working and Reasoning

While a buffer is open:
- focus is tracked
- revisions are tracked
- AI can be used inline via Explain and Ask
- the buffer evolves naturally

The AI is not there to "organise notes" — it acts as a reasoning partner: explaining pasted material, answering questions, helping converge on understanding.

Nothing is being filed yet.

### 3. Closing a Buffer = Intentional Context Release

Judgment only happens when you close the editor tab.

Closing a buffer is treated as: *"I am done with this line of thought for now."*

At this point, Sieve evaluates what happened:
- Was there sustained engagement?
- Did the content evolve?
- Did anything converge into usable understanding?

### 4. Keep or Discard

When a buffer is closed, one of three things happens:

| Intent | Outcome |
|--------|---------|
| User forces **KEEP** | Buffer is retained regardless of quality |
| User forces **TRASH** | Buffer is discarded |
| No explicit intent | Sieve decides automatically |

Discarded buffers are intentionally dropped — like throwing away the back of a napkin after thinking something through. This is an explicit design choice to reduce accumulation and mental noise.

### 5. Stored Notes

If a buffer is kept:
- it is written as plain Markdown
- a descriptive filename is generated
- optional summary and tags are added as frontmatter
- it is placed into the store

The store is just files on disk: no proprietary format, no lock‑in, editable by any Markdown‑capable tool.

---

## Why This Works

Sieve separates thinking from judgment.

You don't decide whether something matters, how to name it, or where it belongs while you are still reasoning about it. That decision is deferred until context has finished doing its job.

The result is:
- fewer open tabs
- lower cognitive overhead
- a cleaner workspace
- a store that contains only material that earned its place

---

## Design Principles

1. **Scratch first, judge later**
2. **Discarding is a valid outcome**
3. **Freeform Markdown, not a closed system**
4. **AI as a reasoning partner, not a filing clerk**
5. **Minimise decisions while thinking**
