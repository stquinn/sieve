# Specification: Internalize URL (Smart Web Clipper)

## 1. Overview
The "Internalize URL" feature is a high-intelligence web clipper for the Stash editor. Unlike traditional clippers that perform raw HTML extraction, this feature leverages AI to act as a **curator**, deciding what information is essential based on the user's current work context.

## 2. User Experience

### 2.1 Triggering the Command
- **Shortcut**: `Ctrl + U` (Proposed).
- **Action**: Opens a centered `PromptModal` titled "Internalize URL" with a text input for the destination URL.

### 2.2 Feedback & State
- Upon submission, a new `AiBlock` is inserted at the cursor location.
- **Initial State**: The block displays "Fetch: [URL]" with a `(fetching...)` or `(evaluating...)` status badge.
- **Completion**: The block updates with a short summary of what was internalized, and the extracted Markdown content is inserted immediately below the `[!ai-end]` marker.

## 3. Intelligent Curation Logic

The feature is "Smart" because it applies judgment rather than just scraping:

### 3.1 Content Evaluation (The Prompt)
The system sends a specialized prompt to the AI containing:
1.  **The Target URL**.
2.  **Current Document Context**: A snapshot of the note the user is currently writing.
3.  **Judgment Instructions**:
    - **Technical/Resource**: Prioritize diagrams, charts, code snippets, and data tables.
    - **News/Report**: Prioritize narrative text; ignore fluff images (stock photos, avatars).
    - **Boilerplate**: Strip navigation, footers, advertisements, and related-article links.

### 3.2 Image Localization Pass
To ensure the note remains self-contained and permanent:
- The AI includes remote image URLs in its Markdown response for assets it deems "essential."
- After receiving the AI response, the Stash frontend performs a **Localization Pass**.
- For every `http` image link, it calls the backend `DownloadImageAsset` tool.
- The image is saved to the local `store/assets/` directory.
- The Markdown is updated to use the local relative path.

## 4. Technical Architecture

### 4.1 Backend (Go)
- **Prompt Template**: `DefaultFetchPrompt` added to `stash/prompts.go`.
- **Logic**: `RunFetch` function in `stash/eval.go` to handle the specific CLI invocation.
- **Tooling**: Uses existing `RunCLI` (for AI interaction) and `DownloadImageAsset` (for localization).

### 4.2 Frontend (React/Tiptap)
- **Gesture**: `fetchGesture` listener for `Ctrl+U`.
- **Integration**: Reuse `AiBlock` extension for the anchor.
- **Post-Processing**: A function to scan AI output for remote links and trigger the localization downloads before final insertion into the ProseMirror document.

## 5. Security & Edge Cases
- **Non-Text Content**: If the URL is a direct link to a PDF or Image, the AI should recognize this and offer a summary or direct download.
- **Paywalls/Auth**: The AI will return an error block if it cannot reach the content.
- **Provenance**: The `AiBlock` must persist the source URL so the "Internalization" can be traced back in the future.
