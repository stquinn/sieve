# Extension: The Workspace Command Plane

*2026-07-23. A direction document — downstream of a decided spec, upstream of
its own. Captured from the design session that produced
`specs/2026-07-23-ask-panel-slash-commands-btw.md` (#55). Not scheduled; its
seed ships in #55 and must merely not be precluded.*

---

## Origin

The /btw design forced a session-scoped WS channel into existence: commands
are workspace-scoped (a `/btw` needs no document; "what's the weather"), so
they cannot ride the per-uuid doc channels — closing a tab must not orphan an
in-flight command. The moment that channel existed with a correlated,
`family`-tagged envelope, the observation followed: **AI commands are just
the first tenant.** Everything else the frontend asks Go to do outside a
document is protocol traffic wearing HTTP request clothing.

## The claim

All workspace functions become commands over the wire:

- The `document-service.js` HTTP families — load/save/raw-content,
  export-source — migrate to `Command` envelopes on the session channel.
- A JS `WorkspaceService` becomes the wire owner beside `block-service.js`
  (per-uuid doc channels unchanged); surfaces stay transport-blind (#49's
  rule is what makes the migration invisible above the service layer).
- The editor request handlers in `requesthandlers/` retire family by family.

```
Command       { family, cmd, args, correlationId, context }
CommandResult { correlationId, cmd, status, block?, error? }
```

## The boundary: below the Workspace, everything is an object

The line is drawn at the workspace subtree, not component-by-component:
**session → tabs → editors → blocks → jobs/commands are all objects**,
reconciling reflected state over the wire — zero HTMX anywhere below the
Workspace. (V-B's "consistency divergence" worry — a lone JS-rendered
tabbar among HTMX peers — dissolves rather than constrains: with the plane
there is no lone component, the whole subtree is one paradigm.)

What stays HTTP sits **beside** the workspace, not below it: the peripheral
library views (sidebar tree, meta panel, prompts list, settings) — read-
mostly renderings of library content, refresh-driven by SSE — plus resource
transport (`/static`, assets, the index shell). Those are not claimed by the
plane; they may migrate someday, but nothing forces it. "The editor request
handlers die" is the claim; "HTTP dies" would be wrong.

## The layering principle (decided in #55, load-bearing here)

**Mechanism on the wire, policy in the tool.** The envelope carries what the
frontend actually has — verb, raw args, the editor-authored context — and
the receiving command decides what happens. Editor authors context → wire
ferries it → tool interprets it. The wire never carries op-shaped args; an
additive command's handler terminates in the same internal op path
paste/transform/extract already call, so effects arrive as ordinary
render-backs and the dispatcher never witnesses them. Context schema:
deliberately unresolved until build time — plausibly a typed core (doc
uuid, selection, block target) + an editor-specific bag; fully-opaque and
fully-rigid are both wrong. Commands read fields opportunistically, never
require them; the empty context is the floor.

## Session-as-reflected-state (completes TECH-DEBT V-B)

The Workspace is the representation of the Session. So tab
open/close/reorder/load are session *mutations* — commands whose reflected
state returns as a **session render-back** the Workspace reconciles into
self-rendering `SieveTab` children. The same pattern as blocks, one scale up:

| Scale | Mutation | Truth | Reflection | Painter |
|---|---|---|---|---|
| Document | block op (doc channel) | ShadowDoc | block render-back | NodeView/renderer |
| Session | command (session channel) | Session (Go) | session render-back | Workspace ⇄ SieveTabs |

`session:changed` for the workspace stops being "SSE ping → HTMX template
refetch" and becomes an unsolicited session render-back on the wire — the
mechanism job completions already use on doc channels — so watcher-driven
external changes push through the identical path. V-B called tabs "the
first mover of components own themselves"; the command plane is the
transport and mutation vocabulary it was waiting for — and with it, V-B is
not one component diverging but the whole workspace subtree converging.

## Wins and costs (named honestly)

**Wins:** save + block ops on one ordered pipe kills a class of transport
races (cousins of the SnapshotForJob coherence guard); one uniform
correlation/ack story; the S3/server future talks one protocol.

**Costs to solve in the epic:** reconnect/replay semantics for correlated
commands (HTTP retries are free, WS ones are not); the session channel needs
the doc channels' ownership guard (the 6e2ccfc lesson).

*Update 2026-08-12 (#74 P1): that guard cost is already paid, and by a
different mechanism than the doc channels'. `handleSessionWS` registers
`__session__` through the same identity-guarded `unregister` (a stale session
socket's teardown cannot evict its successor —
`TestWS_SessionChannel_SuccessorOwnsChannel`), and correlated results do not
use the owner lookup at all: `handleCommand` is **requester-affine**, replying
on the socket the command arrived on and falling back to the current owner only
once the requester is gone (`TestWS_Command_ResultRoutesToRequester_NotChannelOwner`,
the 2026-07-26 stolen-/btw incident). Claim-on-write exists to steer a
**synchronous render-back** to the acting socket; session traffic is
request/reply, so requester-affinity subsumes it. The JS half of the invariant
is `WorkspaceService`: one socket, many tenants — the second socket that the
guard defends against is now impossible to open by accident.*

## The plane's lens: the command palette

Straw-manned during #55: a Ctrl+Shift+Space centered palette is a *second
dispatcher* over the same registry/envelope. Palettes select verbs;
composers compose payloads — /btw is payload-shaped, so the Ask panel is its
door. The palette's moment is when the plane fills the verb inventory
(open/close/load/theme/library-switch as commands): then fuzzy-searching
*all workspace verbs* pays. Completes the summonable triad with Ctrl+P
(nouns) and the Job Engine Viewer (processes — see
`extension-job-engine-viewer.md`).

## Horizon

Plain ask is conceptually the *default attached command* ("ask, attached to
the active document"); the registry may absorb it one day. Explicitly not
part of any current plan; the ask path stays untouched until the plane has
proven itself.

## Sequencing

1. #55 ships and proves the plane (channel, envelope, registry, correlation,
   first tenant).
2. Migration epic: document-service families move family-by-family; each
   retirement is independently shippable.
3. V-B session render-backs (tabs as objects) — possibly its own phase
   inside the epic.
4. Palette arrives when the verb inventory justifies it.

## Cross-references

- Seed spec: `specs/2026-07-23-ask-panel-slash-commands-btw.md` (#55)
- TECH-DEBT V-B (tabs behind the facade), #49 (protocol services,
  transport-blind surfaces), #31 (component model)
- `brainstorm-ai-protocol-roles-chats-and-document-kinds.md` (context as
  curated grant; roles/protocol framing)
- `brainstorm-blocks-all-the-way-up.md` (the session is a typed document
  whose blocks are tabs)
