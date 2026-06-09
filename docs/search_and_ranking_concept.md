# Sieve: Conceptual Approach to Search & Ranking

## The Core Problem
Traditional keyword search fails when developers search based on fuzzy human memory. A user will search for *"that AWS bug I fixed last month"*, but the note might only contain the words `"Amazon VPC"` and `"timeout"`. We need a "Semantic AI Search" capability to bridge the gap between human memory and file contents.

## The Architectural Constraints
1. **No Local Databases:** Sieve adheres to a "just files" philosophy (Markdown + JSON). Introducing SQLite introduces locking issues and breaks simple replication over tools like Nextcloud or Syncthing.
2. **No Heavy Local Models:** Bundling a local vector embedding model (for traditional RAG) bloats the lightweight Go binary.

## The Strategy: Shift Semantic Work to the Filing Phase
Instead of using heavy AI at *search time*, Sieve uses the LLM to perform semantic compression and expansion *ahead of time*—at the exact moments the user interacts with the system.

### 1. Capturing the "Nouns" (Aggressive Tag Expansion)
During the "Keep" / Filing phase, the AI is prompted to aggressively expand tags.
- Instead of just tagging `[aws]`, the AI acts as a semantic thesaurus and writes `[aws, amazon, cloud, infrastructure]` into the Markdown frontmatter.
- This creates a massive "search surface area" in plain text, giving the benefits of a vector database without actually needing one.

### 2. Capturing the "Verbs" (Session Log Summaries)
Developers often remember the *action* they took, not the final state of the document.
- The **Session Log** feature (which groups edits into 30-minute windows and asks the AI to summarize the diff) provides a natural language description of intent (e.g., *"Fixed the routing bug and updated Nginx"*).
- By indexing these Session Log summaries alongside the document metadata, Sieve captures the "verbs" of a user's memory, providing a powerful secondary axis for search.

## The Implementation Concept
Because all of this semantic data is pre-computed into plain text (Markdown frontmatter and Session Log JSON sidecars), Sieve does not need a search database.

1. **In-Memory Materialized View:** On startup, the Go backend reads the frontmatter and session summaries into an in-memory struct slice.
2. **Lightning Fast Filtering:** Go can perform fuzzy text filtering and intersections across tens of thousands of structs in milliseconds. 
3. **Graceful Nextcloud Sync:** Since everything remains as discrete files, background syncs via Nextcloud simply update files on disk, which Go's `watcher.go` can detect and hot-reload into memory.

## Addressing False Positives: Ranking & UX
Aggressive tag expansion increases *Recall* (finding the note) but reduces *Precision* (causing false positives).

To mitigate this, Sieve must introduce **Search Ranking**:
- **High Weight:** Exact matches in the `Filename`, core `Summary`, or exact `Title`.
- **Medium Weight:** Matches in the Session Log summaries.
- **Low Weight:** Matches in the expanded `Tags` array (acting as a safety net at the bottom of the results).

**UX Implication:** The current search UI is too cramped to display this level of rich context. To fully leverage this semantic index, Sieve will likely need a dedicated, wider "Search / Command Overlay" (e.g., `Cmd+Shift+F`) that has enough real estate to show *why* a note matched (e.g., highlighting the matching session log action).
