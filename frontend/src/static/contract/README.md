# contract/ — the Lens↔Host wall

The settled facade design for issue #96 (epic comment 1694). Every type here
is a JSDoc typedef under `// @ts-check`; nothing runs at import time. This
package is a LEAF — it imports nothing, from anywhere — so both the lens side
and the host side can depend on it without depending on each other, and so the
same shapes can later cross a real process boundary (an IPC bridge) unchanged.

Registry formalization (a runtime-checked schema) is explicitly **deferred**
until the boundary crosses a process; until then `tsc --noEmit --checkJs` is
the drift-catcher.

## The three traffic classes

| class | grammar | semantics |
|---|---|---|
| reads | `get*`, sync | answered by the nearest follower model; frozen copies, never references |
| queries | plain name → `Promise` | decisions/offers only, never document content; host-routed |
| verbs | `request*`, void | Go may decline silently; effects arrive only via `onChanged`, which names what changed and never who asked |

Rule: void ⇒ `request*`; a `Promise` return ⇒ a plain name (async is already
visible in the signature, so the prefix would be redundant). `flush` is the
one deliberate exception — see `container-provider.js`.

## `BlockContainerProvider` — the block-writing vocabulary

| member | class | what it says |
|---|---|---|
| `requestAddBlock(kind, attrs, afterBlockId?)` | verb | put a new block of this kind into the container, after this one |
| `requestSetBlock(blockId, patch)` | verb | change this block's state by this delta |
| `requestRemoveBlock(blockId)` | verb | this block should leave the container |
| `requestSetOrder(order)` | verb | this is the order the container's children should be in |
| `requestTransform(blockId, targetKind, operation, entries)` | verb | play back an offer `detectExtractions` produced |
| `requestRetry(blockId)` | verb | run this block's work again |
| `requestPersist()` | verb | put what you already hold on disk, now |
| `paste(payload, afterBlockId)` | query | what should be made of this clipboard/drop/gesture? |
| `detectExtractions(sourceKind, entries)` | query | which kinds can this content become? |
| `flush(blockId, text)` | handoff | here is the in-flight text I have been holding |

Removal is a verb of its own rather than a consequence of some larger
statement about the container's contents: a lens that can delete should not
have to be able to describe the whole container to say so, and deletion is the
one mutation that would otherwise have no way to be asked for.

Order, by contrast, IS stated whole: `requestSetOrder` names every child in the
order it should be in. That is idempotent, it refuses to be half-applied, and
it is the same statement `order-changed` echoes back — complete in both
directions, one mechanism.

`paste` stays ONE query whose payload is a four-kind data union — `smart`,
`slice`, `native-drop`, `native-clipboard` — mirroring the wire's own "one
frame, four kinds". The empty-`DataTransfer` screenshot case is
`{kind:'native-clipboard'}`: data, not a method.

## `WholeContentProvider` — the container as text

| member | class | what it says |
|---|---|---|
| `getContents()` | read (async) | give me the whole container as its authoritative text |
| `setContents(text)` | handoff (async) | this text is the container now — re-parse it |
| `flushContents(text)` | handoff | here is my buffer as it stands; keep it, do not re-parse |

A PROMPT's provider is exactly this and nothing more, and it legally never
cues: nothing but its own lens ever mutates a prompt, so a silent `onChanged`
is the contract holding rather than a hole in it. A DOCUMENT's provider carries
this extension AND the block one — the mode flip is one lens speaking both
vocabularies about one container.

## Birth identity

**A block is born with its durable identity, wherever it is born.** Ids are
UUIDv7 — unique without coordination — so whoever creates a block names it.

| born in | named by | Go's role |
|---|---|---|
| Go (paste, AI, transform, extract) | `ident.New` | mints |
| a lens (prose typed into existence, a split) | `ident.mint` (`ident/`) | validates |

Validation has exactly two answers, and both are refusals rather than
corrections: the id is malformed, or the container already uses it. Silently
substituting one would leave the creator addressing a block that no longer
answers to the name it gave.

The consequence is that there is no pending identity anywhere — no transient
handle, no swap-on-ack, no correlation. A lens's node carries `data-id` from the
first keystroke, and it recognises the block's arrival by the plain id it chose.

## Red lines

1. **Interface-only.** A lens depends on the shapes here, never on a concrete
   host or model. Nothing in `contract/` names `Editor`, `Workspace`, or any
   other implementation.
2. **Serializable at the stream, copies at the reads.** Everything crossing
   the wall is JSON-shaped — it must survive `structuredClone`. No
   ProseMirror types, no DOM nodes, no live object references, in either
   direction.
3. **Verbs never return results.** A `request*` call's only visible outcome is
   a later `onChanged`; there is no ack channel in this contract, and no
   correlation either — a lens is told that A change happened, never that ITS
   change happened. (Wire-level opId acks are transport plumbing far underneath
   this wall, where they settle a promise; they do not surface through it.)
4. **Follower, never leader.** A lens never applies a structural change
   optimistically — it forwards an intent and waits for Go's echo. The one
   sanctioned exception is in-flight text (`flush`), which is why `flush` is
   spelled differently from every verb around it.

## Files

- `container-provider.js` — the business half: `ContainerProvider` (read-only
  minimum) → `BlockContainerProvider` (adds block verbs + paste/extraction
  queries + flush) and `WholeContentProvider` (the container-as-text trio a
  markdown lens and the mode flip speak).
- `container-update-listener.js` — the one inbound channel: `onChanged`,
  post-fold, origin-blind.
- `selection-listener.js` — the one channel that flows the other way: a
  lens's selection/focus/caret advertisement, host-consumed.

## Package DAG (issue #96 comment 1694, target layout)

```
contract/    the wall — imports NOTHING (leaf; both sides depend on it)
container/   host data plane: ContainerModel, ContainerTransport,
             ProviderAdapter, DocumentService     → imports contract, generated protocol
renderers/   PM-free block look-and-feel          → imports contract
lens/        Lens base + BlockLens/NoteLens, OutlineLens, PM surfaces
                                                   → imports contract + renderers ONLY
shell/       the host: workspace, tab, MountBinding, workspace-wire tenants
                                                   → imports contract, container, lens
```

`lens/` containing zero imports from `container/` or `shell/` is the firewall
made checkable — `frontend/test/contract-purity.test.js` enforces the leaf
property of THIS package the same way; the equivalent tripwire for `lens/`
lands with the P4 move.
