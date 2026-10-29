# Copy and paste matrix

Every copy and paste scenario Sieve commits to, the outcome it must produce, and how that outcome is verified.
`docs/editor-interaction-contract.md` §Copy and cut matrix and §Paste matrix stay the NORMATIVE mechanism contract (which handler, which clipboard views); this document is the behaviour each scenario must show, and the rules it follows from.

Terms used throughout:

- **Smart paste**: Go recognising a block in pasted content (a URL, an image, code, a log, a fence) and placing that block.
- **`sieve/slice`**: the clipboard's own block view, one entry set per copied block; **`sieve/<kind>`** (`sieve/code`, `sieve/diagram`, …) is a single copied block's own view.
- **`NodeSelection`**: a whole block selected (gutter click, or an atom such as an image clicked).
- **Native paste**: ProseMirror's own paste of the clipboard into the editor, with no round trip to Go.
- **K** = Ctrl/Cmd+C, X, V. **M** = context-menu Copy, Cut, Paste. A row uses K unless it says otherwise.
- **Undo** = one Ctrl/Cmd+Z, restoring the document exactly as it was before the gesture.

## Rules

Every row below cites the rules it follows from. A rule names the decision of record on issue #193 it rests on; reversing that decision means re-deciding every row that cites the rule.

**R-1. A paste lands inside what the caret is in.** A paragraph, a list item, a table cell, a code block: the pasted content goes into it, and nothing is ever created outside the block or cell the user aimed at. A paste into a read-only region (a log, a web-clip body, an ai-block's read-only parts) is consumed and changes nothing. *(decision 11; contract §Paste matrix)*

**R-2. Go gets first look at every paste; the editor's native paste gets the rest.** When Go recognises a block it places that block. When it declines, ProseMirror's own paste runs on the ORIGINAL clipboard event, with the original `text/html` and its open-paragraph context. There is no replay of clipboard content by any other means. *(decision 12)*

**R-3. Part of a block is its characters; a whole block is the block.** A copy of part of a block's content puts those characters on the clipboard and no `sieve/*` view. A copy of a whole block (a `NodeSelection`, a gutter range, or a range covering the block entire) puts the block on the clipboard, and pasting it makes a new block of the same kind and content with a new id. The rule is the same for every kind. *(decision 3)*

**R-4. Keyboard and menu agree.** Menu Copy and Cut produce exactly the clipboard Ctrl/Cmd+C and X produce. Menu Paste is a text paste: it reads `text/plain` (and `text/html` where the platform offers it) and sends it down the smart-paste path; only Ctrl/Cmd+V rebuilds blocks from `sieve/*` views. *(decisions 1, 2)*

**R-5. `text/plain` is readable plain text with its structure kept.** Table cells are separated by a tab and rows by a newline; list items keep a marker (`- ` for a bullet, `1. ` for an ordered item); blocks are separated by one blank line. It never holds markup, html entities, markdown escapes or block chrome (gutter numbers, handles, badges). `text/html` carries the formatting. *(decision 4)*

**R-6. Every paste mints ids.** Every pasted block and every element inside a pasted container gets a fresh id, and a copy never takes its source's id. Cut-and-paste is a copy plus a delete, so it mints too; a block keeps its identity only when it is moved by the gutter drag, which never touches the clipboard. *(decision 13)*

**R-7. Plain text pasted into prose is read as markdown.** `# Title`, `- item`, `**bold**` and a pipe table pasted as text render as a heading, a list, bold and a table. *(decision 9)*

**R-8. Smart paste claims text only when it is confident, and is always reversible.** Markdown-shaped prose, and anything under the length floor, is never claimed as code. Whatever smart paste decides, one undo removes it, Undo Smart Paste puts the text back verbatim, and Paste as plain text bypasses it. *(decisions 5, 6)*

**R-9. A pasted block that holds an asset holds its own copy.** Pasting a smart-image (or any asset-bearing block) copies the asset's bytes into the target document and addresses that copy as `sieve://{target}/{key}`; it never points at the source document's asset. *(decision 10)*

## Escape hatches

| Gesture | Result | Status |
|---|---|---|
| Ctrl/Cmd+Shift+V, and context menu "Paste as plain text" | The clipboard's `text/plain`, literal, at the caret. No smart paste, no markdown parse. | pass |
| Undo Smart Paste (context menu on a smart-pasted block) | The pasted text back verbatim, at the paste location, as prose: indentation and blank lines kept, runs of spaces as no-break spaces (a tab as four spaces), no markdown parse. | pass |
| Copy source (code, diagram) | The block's inner text alone: no fence, no language line. | pass |
| Copy Image (smart-image) | A PNG on the clipboard, for other applications. | pass |
| File › Export › Clipboard | The whole document as Markdown, Confluence or Confluence Cloud. | pass |

## Status key

- `pass`: the row holds, pinned by the named test or confirmed by running its manual steps.
- `open: Rn`: the row fails today; `Rn` names the root cause below. `open: defect` names a failure with no shared root cause, described in a footnote.
- `planned`: the behaviour is decided and not built.
- `blocked: <why>`: the row cannot be run in the verification environment.
- `unrun`: a manual row whose steps have not been run.
- `auto: to pin` in the Verified-by column: the row is automatable and no test pins it yet.

Root causes (written `R1`…`R9`, distinct from the rules `R-1`…`R-9`):

| Cause | What fails |
|---|---|
| R1 | On a paste Go declines, the editor re-inserts the clipboard with `insertContent` instead of ProseMirror's native paste: the html's open-paragraph context is lost (the target splits, list/task/quote context drops), a text-only clipboard is markdown-parsed and double-escaped (`->` shows `-&gt;`), and a pasted `data-id` is kept. |
| R2 | A processor takes the first clipboard entry it can read (`text/plain`, a link, a uri-list) before the block's own `sieve/<kind>` view, so a copied block is rebuilt by detection instead of from its view. |
| R3 | A read-only region is not a paste gate: a paste with the caret in a web-clip or ai-block body reaches Go, and a decline inserts into the body. |
| R4 | `text/plain` for structured content is ProseMirror's default text dump: tables lose their row and cell separators, lists lose markers, a cell selection includes unselected cells, and an atom's text is its rendered chrome. |
| R5 | Menu Copy, Cut and Paste are a second clipboard writer/reader (plain text only); the ai-block node menu's Copy and Cut abort. |
| R6 | Any `text/html` containing an `<img>` is claimed whole as a smart-image, dropping the rest of the paste. |
| R7 | Detection heuristics: prose with more than two braces reads as code; a JS function is claimed with no language. |
| R8 | Undo Smart Paste strips indentation, blank lines and spacing, then markdown-parses the result; a late render-back makes a smart paste two undo steps. |
| R9 | The markdown serializer writes `>` as `&gt;` on save, so a document holding `->` is stored as `-&gt;` (it renders back as `->`, but markdown mode, Export › Markdown and the file on disk show the entity). |

## Scenario register

### A. Prose to prose (WYSIWYG)

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| A1 | Copy a word from mid-paragraph, paste mid-word elsewhere | The word's characters are inserted at the caret. No new paragraph; no marks unless the source had them. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A1 a word mid-paragraph: no split"; live app | pass |
| A2 | Copy across two paragraphs, paste into the middle of a third | The third paragraph splits at the caret: its head joins the first copied paragraph, the second copied paragraph joins its tail. Two paragraphs result where there was one, text intact. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A2 two paragraphs into a third: split once, text intact" | pass |
| A3 | Copy **bold**, *italic*, `inline code` and a link, paste | The same marks, and the link's href is the source href. | R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "E9 markdown source as text still renders" (bold); "smart-paste outcome:none, %s, anchor kept" (html and text → pasteHTML) | pass |
| A4 | Copy text containing `->`, `<`, `>`, `&`, `*`, `_`, a backtick, `#`, `\|` and `\` inside a paragraph, paste | The exact character string, no `&gt;`/`&amp;`, no backslash escapes. | R-2, R-5 | `prose-identity.test.js` "%s: text/plain is the plain text, sieve/prose the markdown" (copy side); paste side auto: to pin | pass |
| A5 | Copy a heading, paste into an empty paragraph; then mid-paragraph | Empty paragraph: a heading of the same level. Mid-paragraph: the heading's text only, in the paragraph. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A5-mid heading text mid-paragraph: text only"; empty-paragraph half auto: to pin | pass |
| A6 | Copy one list item, paste into another list | Copying a range inside one list item pastes inline into the target item (`banana` copied from inside an item, pasted into `cherry`, gives `cherrybanana`). Copying a range that crosses the item boundary (the whole item) pastes a sibling item in the target list. No nested list, no new list. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A6 a list item (copied across the item boundary) into a list: a sibling item" | pass |
| A7 | Copy a two-level nested list, paste into an empty paragraph | The same two-level nesting. | R-2 | auto: to pin | pass |
| A8 | Copy a checked task item, paste | A task item, checked. | R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A8 a task item keeps checked" | pass |
| A9 | Copy a blockquote, paste | A blockquote (not a code block). | R-2, R-8 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A9 a blockquote stays a blockquote" | pass |
| A10 | Copy emoji, CJK, RTL text and a combining accent, paste | Byte-identical text. | R-2 | auto: to pin | pass |
| A11 | Copy a line holding a hard break (Shift+Enter), paste | The hard break is kept; no paragraph split. | R-2 | auto: to pin | pass |
| A12 | Paste over a selection within a paragraph | The selection is replaced by the paste. Undo restores the selected text. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A12 over a selection: replaced, the source keeps its id" | pass |
| A13 | Paste over a selection spanning paragraph + code block + paragraph | The range is replaced by the paste; the code block is gone. Undo restores all three, the code block with its original id. | R-2, R-6 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "A13 over a range spanning a code block: replaced, one undo restores all three" | pass |
| A14 | Cut a paragraph, paste it further down | Moved, with a new id. The first undo removes the paste, the second restores the cut. | R-2, R-6 | auto: to pin | pass |
| A15 | Copy prose, paste three times | Three copies; each paste is its own undo step. | R-2 | auto: to pin | pass |
| A16 | Copy a paragraph, paste it ABOVE its source | The source paragraph keeps its id; the pasted paragraph has a new one. | R-6 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "ids never ride the clipboard: whole paragraphs pasted above their source arrive id-less"; `prose-identity.test.js` "a pasted prose node carries no copied id" | pass |
| A17 | Type or paste `go -> stop`, save | The file on disk holds `go -> stop` | R-5 | `prose-identity.test.js` "prose text's stored markdown" "%s" ("A17 an arrow"); `TestDocumentCodec_RoundTrip` (holds `go -> stop, 1 < 2 & done.`); live app | pass |

### B. Tables

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| B1 | Cell text → another cell | The text goes into the target cell. No inner table. | R-1 | `surfaces.test.js` "caret in %s, clipboard holds %s → native paste, Go never asked"; `paste-context.test.js` "caret in %s → %s" | pass |
| B2 | A 2×2 cell selection → a cell | The 2×2 cells are pasted over the 2×2 starting at the target cell; the table grows if needed. | R-1 | The text view: `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "B10 a cell selection is only the selected cells" (only the selected cells); paste half auto: to pin | pass |
| B3 | Paragraph text → a cell | The text is in the cell; nothing appears below the table. | R-1 | `surfaces.test.js` "caret in %s, clipboard holds %s → native paste, Go never asked" | pass |
| B4 | Multi-paragraph text → a cell | The paragraphs are inside the cell. No block outside the table. | R-1 | auto: to pin | pass |
| B5 | A list, a code block, or a URL → a cell | List: the first item merges into the cell's paragraph, the rest nest as a list inside the cell. Code: its text, literal. URL: a link whose text is the whole URL. No block outside the table. | R-1 | `surfaces.test.js` "caret in %s, clipboard holds %s → native paste, Go never asked" | open: defect[^b5] |
| B6 | Cell text → a top-level paragraph | The cell's text only, inline at the caret; not a one-cell table. | R-1, R-2 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "B6 cell text at the end of a paragraph: inline"; "B6b cell text mid-paragraph: inline, no split" | pass |
| B7 | A whole table (gutter selection) → top level | A new table with the same cells. | R-3 | auto: to pin | pass |
| B8 | html `<table>` (browser page) or TSV (spreadsheet) → top level | html: a Sieve table with the same cells. TSV pasted as text into a paragraph stays text. | R-2, R-7 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "B8 an html table behind <meta charset>: no stray paragraph"; live app | pass[^b8] |
| B9 | Copy a table (`Fruit`/`Qty`, `Apple`/`3`) → a plain-text editor | `text/plain` is `Fruit\tQty` newline `Apple\t3`; no html, no blank lines between rows. | R-5 | `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "B9 a table: rows by newline, cells by tab"; manual: copy the table, paste into a text editor | pass |
| B10 | A CellSelection of some cells → a plain-text editor | `text/plain` holds only the selected cells, tab- and newline-separated as B9. | R-5 | `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "B10 a cell selection is only the selected cells" | pass |

[^b5]: `x`, then a URL, then `x` pasted into one cell gives a link missing the URL's last character (TipTap Link paste rule).
[^b8]: Live app: pass for all three shapes.

### C. Sieve blocks: copy, then paste in Sieve

C1 has one row per kind.

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| C1 code | Whole code block → top level, same document | New block, same kind, same content, same language, new id; aliases not copied. | R-3, R-6 | `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-code"; `TestFirstPasteMatch_ownViewFirstInRealClipboardOrder`; `TestCodeBlockProcessor_InitAttrs_suppliedLanguageIsKept` | pass |
| C1 diagram | Whole diagram → top level, same document | New block, same kind, same source, new id; it renders afresh (the source's render is not reused). | R-3, R-6 | `TestDiagramProcessor_TransformSieveCopyStripsRenderState` | pass |
| C1 log | Whole log block → top level, same document | New block, same kind, same content, new id, rebuilt from its `sieve/log` view. | R-3, R-6 | `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-log" | pass |
| C1 smart-image | Whole smart-image → top level, same document | New block, new id, `src` = `sieve://{doc}/{key-2}`: a second asset holding the same bytes beside the source's. | R-3, R-6, R-9 | `TestSmartImageProcessor_Transform_copiedBlock` "within one document, a second asset" | pass |
| C1 smart-card | Whole smart-card → top level, same document | New smart-card, same URL, new id; it fetches its own face. | R-3, R-6 | `TestSmartCardProcessor_Transform_copiedCardFetchesItsOwnFace`; `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-smart-card" | pass |
| C1 reference | Whole reference → top level, same document | New reference, same target, new id. | R-3, R-6 | `TestReferenceProcessor_Transform_copiedOrPlacedReference`; `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-reference" | pass |
| C1 web-clip | Whole web-clip → top level, same document | New web-clip, same source and body, new id. | R-3, R-6 | `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-web-clip" | pass |
| C1 ai-block | Whole ai-block → top level, same document | New ai-block, question and answers kept, new id. | R-3, R-6 | `TestAIBlockPaste_clipboardViewIsClaimedAndRebuilt` | pass |
| C2 | C1, into another open document (second tab) | As C1. An asset-bearing block holds its own copy: `src` = `sieve://{target}/{key}`, never the source document's address. | R-3, R-6, R-9 | `TestSmartImageProcessor_Transform_copiedBlock` "across documents"; `TestEditorService_HandlePaste_wholeBlockCopyPerKind` (another document); manual: copy a code block and an image in tab 1, paste in tab 2;<br>check kind, language, and that the image's `src` names tab 2's document | pass (Go); manual half unrun |
| C3 | Partial range inside code → a paragraph | The selected characters, pasted as any text is: prose, or a block if smart paste is confident. No `sieve/*` view is written. | R-3 | `interaction-policy.editor.test.js` "%s: C3 a partial range writes no sieve/* view"; `clipboard-slice.test.js` "what goes on the clipboard" "C3: a partial %s range writes its characters and no sieve/* view"; "a range of several blocks: one covered in part is its characters as prose, one covered whole keeps its views" | pass |
| C4 | Partial range inside code → another code block | The selected characters, literal, at the caret. | R-1, R-3 | `paste-context.test.js` "caret inside a code:true block → true (paste stays literal)"; `surfaces.test.js` "caret in a raw-text block → returns false (native paste), no insert" | pass |
| C5 | Gutter range of prose + code + diagram → top level | Three blocks in source order, each a new id, code keeping its language. | R-3, R-6 | `TestEditorService_HandlePasteSlice_oneBlockPerItemInOrder` (order); `TestEditorService_HandlePaste_wholeBlockCopyPerKind` (language) | pass |
| C6 | Cut a code block, paste it elsewhere | Moved: same kind, content and language, new id. Undo puts it back. | R-3, R-6 | `TestEditorService_HandlePaste_wholeBlockCopyPerKind` (the paste half); cut + undo auto: to pin | pass |
| C7 | Copy a range of elements inside an ai-block → top level | The elements as top-level blocks; no ai-block. | R-3 | `clipboard-slice.test.js` "is composed per element — the answer pastes as the blocks it showed" | pass |
| C8 | Copy the whole ai-block → top level | The ai-block re-imported, question and answers kept. | R-3 | `TestAIBlockPaste_clipboardViewIsClaimedAndRebuilt`; `TestAIBlockPaste_fencedFormIsClaimedAndParsed` | pass |
| C9 | Code "Copy source" → a paragraph | The source text only, no fence; then smart paste as for any multi-line text. | R-8 | `code-node-view-menu.test.js` "copies the inner text alone — no fence, no language line" | pass |
| C10 | Smart-image Copy Image → paste in Sieve; and into an image application; and Ctrl/Cmd+C of the image → a text editor | Sieve: a smart-image whose asset is stored in the target document. Image application: the PNG. Text editor: no gutter number, handle or badge text. | R-5, R-9 | `clipboard-slice.test.js` "a selected image is copied as a block" "%s, every view is composed" (text/plain is the asset address, no chrome); bitmap and paste halves: manual: Copy Image, paste into Sieve and into GIMP;<br>Ctrl+C the image, paste into a text editor | pass |
| C11 | Copy Link / Copy URL → a paragraph | A link whose text is the page title (the URL when no title arrives). | R-2 | `TestLinkPaste_Result` | pass |
| C12 | Copy an ai-block, paste it | Every element inside the pasted ai-block has a fresh id; none shares an id with the source. | R-6 | `TestAIBlockPaste_elementsGetFreshIDs`; `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-ai-block/C12" | pass |
| C13 | Copy a smart-image with a title, paste | The pasted image keeps the `title`. | R-3 | `smart-image-summary.test.js` "SmartImageNodeView schema"; `TestEditorService_HandlePaste_wholeBlockCopyPerKind` "C1-smart-image/C13" | pass |


### D. Paste into blocks that are not prose

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| D1 | Markdown or html → a code block | The text, literal; no conversion. | R-1 | `paste-context.test.js` "caret inside a code:true block → true (paste stays literal)" | pass |
| D2 | Text → diagram source (edit mode) | The text, literal; the diagram re-renders. | R-1 | `surfaces.test.js` "caret in a raw-text block → returns false (native paste), no insert" | pass |
| D3 | Anything → a log block | Consumed: the document is unchanged, no error. | R-1 | `surfaces.test.js` "caret in %s, clipboard holds %s → native paste, Go never asked" (read-only region gate); `paste-context.test.js` "caretInReadOnlyRegion" | pass |
| D4 | Multi-line text → an inline input (find bar, rename field, ask panel) | The input receives the text; the editor does nothing. | R-1 | manual: open the find bar, paste three lines;<br>check the find bar holds them and the document is unchanged | blocked: no rename field for an unfiled buffer (find bar: pass) |
| D5 | Anything → a web-clip body or an ai-block's read-only region | As D3: consumed, document unchanged. | R-1 | `surfaces.test.js` "caret in %s, clipboard holds %s → native paste, Go never asked" (read-only region gate); `paste-context.test.js` "caretInReadOnlyRegion" | pass |

### E. Smart-paste detection (from outside: text/plain or html)

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| E1 | A bare https URL into an empty paragraph | A link whose text is the fetched title (3 s deadline); on timeout, a link whose text is the URL. | R-2 | `TestLinkPaste_Result`; `TestLinkPaste_BoundsTheFetch`; `TestEditorService_HandlePaste_urlBecomesContent`; `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "smart-paste outcome:content → pastes GO's fragment as html, not the clipboard, and never consumes the anchor" | pass |
| E3 | An image URL | A smart-image, asset stored in the document. | R-8, R-9 | `TestSmartImageProcessor_IsSupportedContent_nativeURL_offersTransform` | pass |
| E4 | A 10-line Go, JS or Python function | A code block with that language (`go`, `javascript`, `python`). | R-8 | `TestCodeBlockProcessor_IsBlock_unfencedCode` "E4 javascript", "E4 python" (claimed, and the language checked); `TestDetectByHeuristics_javascript` "%s"; live app | pass |
| E5 | 2–3 lines of prose holding `->`, `: `, `> `, `**`, `{}` | Prose, never code; `->` shows as `->`. | R-7, R-8 | `TestLooksLikeCode_prose` "E5 braces wrapping words"; `TestLooksLikeCode_braceLines` "%s"; `TestCodeBlockProcessor_IsBlock_unfencedProseIsNotCode` "E5 braces wrapping words"; `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "#192 `->` as text reads `->`" (the `->` display) | pass |
| E6 | A single line of code (`x := 1`) | Inline text at the caret; under the length floor. | R-2, R-8 | `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "E6-js `x := 1` mid-paragraph: inline"; `TestLooksLikeCode_tooShort`; `TestCodeBlockProcessor_IsBlock_unfencedProseIsNotCode` "under the length floor" | pass |
| E7 | Log lines (timestamps and levels) | A log block. | R-8 | `TestLogProcessor_IsBlock` | pass |
| E8 | A ```` ```mermaid ```` fence; a ```` ```go ```` fence | Mermaid: a diagram. Go: a code block, language `go`. | R-8 | `TestDiagramProcessor_IsBlock_mermaidFence`; `TestCodeBlockProcessor_IsBlock_withLanguage` | pass |
| E9 | Markdown text: headings, lists, a pipe table, `**bold**` | Rendered prose: heading, list, table, bold. | R-7 | `TestCodeBlockProcessor_IsBlock_unfencedMarkdownIsNotCode` (Go declines); `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "E9 markdown source as text still renders" | pass |
| E10 | Rich html from a web page (headings, links, inline images, `<pre>`) | Prose with its marks; `<pre>` becomes a code block; a remote image becomes a link to its URL (its alt text as the label), never a broken image. | R-2, R-8 | `TestSmartImageProcessor_IsSupportedContent_htmlClaimedOnlyWhenItIsAnImage` "%s" (E10); `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "E10 a web page: prose with its marks, <pre> a code block, the image a link to its URL"; "an image Sieve serves (data: or its own route) stays an image"; live app | pass |
| E11 | Text out of VS Code (html with inline styles + text/plain) | A code block from the text, not styled prose. | R-8 | auto: to pin (synthetic clipboard) | pass |
| E12 | Text out of a terminal | Treated as any `text/plain`. | R-2 | manual: copy three lines from a terminal, paste into a paragraph;<br>check the outcome matches the same text pasted from a text editor | pass |
| E13 | Undo Smart Paste after E4, E7 or E8 | The pasted text back verbatim as prose at the paste location: indentation and blank lines kept, runs of spaces as no-break spaces (a tab as four spaces)[^e13]; `__init__` stays `__init__`. | R-8 | `TestProseProcessor_Transform_undoReturnsSafePlainText` "%s"; `TestProseProcessor_IsSupportedContent_offersUndoForTaggedSource` | pass |
| E14 | Ctrl/Cmd+Z straight after a smart paste | One undo removes the block and leaves the document as before the paste, however late the block renders back. | R-8 | `surfaces.test.js` "E14 one undo after a smart paste whose block lands 600ms after the ack" (render-back at +600 ms, one undo) | pass |
| E15 | Rich html with text and one reachable `<img>` | The text is kept as prose; the image becomes a link to its URL.[^e15] | R-2, R-8 | `TestSmartImageProcessor_IsSupportedContent_htmlClaimedOnlyWhenItIsAnImage` "%s" (E15); `surfaces.test.js` "WysiwygSurface — a declined paste is ProseMirror's own paste (#193 paste matrix)" "E15 text and one <img>: the text kept, the image a link; an <img> inside a link is its alt text" | pass |

[^e13]: Spacing reads back as no-break spaces and a tab as four spaces: visually exact, not byte-identical.
[^e15]: A smart-image among the text would need Go to split mixed html; a link loses nothing and never renders broken.

### F. OS clipboard and files (WebKitGTK)

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| F1 | A screenshot copied to the clipboard → a paragraph | A smart-image; the asset stored in the document. | R-9 | `TestHandleNativeClipboard_ImageTakesTheOrdinaryPastePath`; manual: PrintScreen to clipboard, Ctrl+V in a paragraph;<br>check a smart-image appears and its asset is listed in the Assets panel | pass |
| F2 | An image file copied in the file manager → paste | A smart-image. | R-9 | `TestPasteMatch_anImageNeverReachesReference`; manual: copy a PNG in the file manager, Ctrl+V;<br>check a smart-image appears | pass |
| F3 | A PDF or zip copied in the file manager → paste | A reference block; the asset stored. | R-9 | `TestHandleNativeClipboard_CopiedFilesTakeTheDropIngestion`; `TestPasteMatch_aNonImageBecomesAReference`; manual: copy a PDF, Ctrl+V;<br>check a reference block appears | pass |
| F4 | Drag an image file from the desktop | A smart-image at the drop point. | R-9 | manual: drag a PNG from the file manager into the document;<br>check a smart-image lands where it was dropped | blocked: no drag source under Xvfb |
| F5 | Paste when the clipboard holds nothing Sieve can read | Nothing changes; no error, no repeated toast. | R-2 | `TestHandleNativeClipboard_NothingUsableIsNothing`; manual: put an unreadable target on the clipboard (`xclip -t application/x-foo`), Ctrl+V;<br>check the document and toasts are unchanged | pass |

### G. Outbound: Sieve to other applications

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| G1 | Prose with a heading, a list and bold → a plain-text editor | `text/plain`: `Title`, blank line, `- one` newline `- two`, blank line, `a bold word`. No entities, no escapes, no `**`. | R-5 | `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "G1 heading, list and bold: no markup, one blank line between blocks"; "an ordered list numbers from its start; a nested list sits two spaces in"; "task items carry their box"; "a hard break is a newline" | pass |
| G2 | Prose → a rich editor (LibreOffice, a mail client) | Formatting kept through `text/html`. | R-5 | manual: copy formatted prose, paste into LibreOffice Writer;<br>check headings, lists, bold and links survive | unrun[^g2] |
| G3 | A whole code block → a plain-text editor | The source only; no fence. | R-3, R-5 | `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "G3 a whole code block is its source"; manual: gutter-select a code block, Ctrl+C, paste into a text editor | pass[^g3] |
| G4 | File › Export › Clipboard as Markdown / Confluence | The whole document in the chosen format, images included. | — | `shell.test.js` "flushes first, then writes the SERVER's %s export to the Wails pasteboard (primary)"; manual: export each format, paste into a text editor;<br>check every block and image is present | open: defect[^g4] |

[^g2]: The `text/html` view carries WebKit inline `color: rgb(0,0,0)` styles.
[^g3]: `text/plain` is the bare source. `text/html` is the rendered block, not a `<pre>`.
[^g4]: Markdown export writes images as `/ui/assets/…`, not `sieve://` addresses; Confluence DC export drops images to empty paragraphs.

### H. Gesture parity and other surfaces

| ID | Scenario | Expected | Rules | Verified by | Status |
|---|---|---|---|---|---|
| H1 | M-Copy a code block → K-Paste | The same result as C1 code. | R-4 | `context-menu-structure.test.js` "the clipboard items" "%s runs the keyboard's %s on the selection" (H1 Copy) | pass |
| H2 | K-Copy a code block → M-Paste | A text paste of the block's source, through smart paste (a code block if detection is confident); never a `sieve/*` rebuild. | R-4, R-8 | `context-menu-structure.test.js` "the clipboard items" "H2 Paste hands the lens %s; never execCommand" (the three clipboard shapes: text and html, text alone, text alone after a refused `clipboard.read()`); `surfaces.test.js` "H2 context-menu Paste of %s: Go asked with those views, a decline pastes them natively"; manual: gutter-select a code block, Ctrl+C, then context-menu Paste in a paragraph;<br>check the result equals pasting the same source as text | unrun |
| H3 | M-Cut a selection spanning blocks | The same as K-Cut: the clipboard as A13/C6 compose it, the range removed. | R-4 | `context-menu-structure.test.js` "the clipboard items" "%s runs the keyboard's %s on the selection" (H3 Cut) | pass |
| H4 | Ctrl/Cmd+Shift+V, or menu "Paste as plain text" | The clipboard's `text/plain`, literal, at the caret: no smart paste, no markdown parse. | R-8 | `interaction-policy.editor.test.js` "Mod+Shift+V paste as plain text (H4)"; `context-menu-structure.test.js` "the clipboard items" "H4 Paste as plain text hands the lens the clipboard's text/plain"; `surfaces.test.js` "H4 paste as plain text in a read-only region: nothing pasted, Go never asked"; "H4 paste as plain text: %s" (six literal cases on the real editor) | pass (live: WebKitGTK delivers the chord's paste event) |
| H5 | Markdown mode: copy and paste inside the textarea | Native textarea behaviour; literal text. | R-1 | manual: switch to markdown mode, copy a line, paste it below;<br>check it is byte-identical | pass |
| H6 | Copy in WYSIWYG, paste into markdown mode | `text/plain` with structure kept (R-5): `- ` markers, tab-separated cells, one blank line between blocks. No html, no `sieve/` noise. | R-5 | `interaction-policy.editor.test.js` "clipboard text/plain keeps structure (R-5)" "H6 a range of heading, code block and list: every block keeps its structure" | pass |
| H7 | Copy in markdown mode, paste into WYSIWYG | Rendered as E9. | R-7 | auto: to pin (synthetic clipboard) | pass |
| H8 | Ask composer: paste markdown or code | The composer is a WYSIWYG surface: markdown renders; code keeps its indentation and tabs. | R-2, R-7 | manual: open Ask, paste a markdown block, then a tab-indented Python function;<br>check the markdown renders and the indentation survives | unrun |
| H9 | ai-block node menu Copy / Cut | The same clipboard as K-Copy / K-Cut of the whole ai-block (C8). | R-4 | `context-menu-ai-block.test.js` "context-menu.js — ai-block Copy / Cut (H9)" "%s selects the block, then runs the keyboard's %s" | pass |

## Maintenance

Each change to copy or paste behaviour updates the affected rows, and their pinning tests, in the same change. A row's status is `pass` only when a named test pins it or its manual steps were run against the change. Reversing a decision means re-deciding every row that cites a rule resting on it, and nothing else.
