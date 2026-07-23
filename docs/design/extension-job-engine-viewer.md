# Extension: The Job Engine Viewer

*2026-07-23. A direction document — downstream of a decided spec, upstream of
its own. Captured from the design session that produced
`specs/2026-07-23-ask-panel-slash-commands-btw.md` (#55). Not scheduled; its
seed (the /btw status-bar badge) ships in #55 and must merely not be
precluded.*

---

## Origin

The /btw UX settled on: dispatch → status-bar badge in the existing
active-job surface (nothing covers the document); terminal result → the
popup emerges from the badge; the badge persists while an answer is held and
click toggles the popup. Then the generalization landed: the badge could be
a *list* — a centered, summonable UI over **all** active and held work. And
that list is something the job-engine design has never had: **the home for
jobs.**

## The gap it fills

Today a job's only UI is its render-back target. Block jobs paint status on
their block; the meta panel has its "Thinking" spinner; the status bar has
fragments (split between `ai-actions` and the `StatusBar` class — catalogued
X-C debt). There is no place to see *the engine itself*. Homeless jobs were
literally impossible before #55 — every job had a block to live on.
Commands created the first homeless jobs; correlation IDs gave them
identity; the viewer is where they live.

## The shape

A **lens over the JobTracker's full truth** — every job, block-backed or
correlated: active, pending, held. Summoned from the status bar badge (or a
chord); centered list, the quick-switcher paradigm. Each row links to its
home:

- block-backed job → scroll-to-block (its status chrome is already there);
- correlated command job → re-open its popup (the UI-persistent result —
  the /btw held answer, graduated from one to many).

The viewer **aggregates; it never replaces block chrome.** It is also where
job affordances that currently have nowhere to live finally land: cancel,
retry, grouped-by-category (worker pools are already per-category),
"what's stuck". `top` for Sieve; IntelliJ's background-tasks panel is the
familiar cousin.

## Retention is structural, not a flag

The rule fell out clean: **a job's result always lives somewhere.**

- Transient jobs (filing, explain, plantuml renders, web-clip fetches)
  **leave the viewer on completion** — their render-back home (block, meta)
  holds the result; the viewer letting go loses nothing.
- Homeless correlated jobs (/btw) **stick** — the viewer IS their home,
  holding the UI-persistent result until dismissed or replaced.

Derivable from "does the job have a render-back target"; no per-job
declaration needed in the common case. (An override flag can exist later if
a block-backed job ever wants to linger; none is known to.)

## The triad it completes

| Surface | Enumerates | Status |
|---|---|---|
| Ctrl+P quick switcher | **nouns** (documents) | exists |
| Command palette | **verbs** (commands) | arrives with the command plane (`extension-workspace-command-plane.md`) |
| **Job Engine Viewer** | **processes** (running/held work) | this document |

Centered summonable lists are right for *enumerable* things (the #55 palette
straw-man's own verdict); processes are the third enumerable axis.

## Interactions with existing debt/designs

- **Job-engine design (2026-06-30, committed):** processors declare jobs,
  framework owns lifecycle, per-category worker pools. The viewer is the
  missing UI half of that design — the framework's lifecycle made visible.
- **Status-bar split (X-C):** `ai-actions.updateStatusBar` hand-builds half
  of what the `StatusBar` class owns. The viewer's arrival is the natural
  moment to unify all job-status UI behind one owner.
- **#55's only obligation:** correlated command jobs register in the
  JobTracker like every other job — so the viewer's truth is already
  complete the day it is built. (Ships in #55.)

## Sequencing

1. #55 ships the single-answer badge (a list of one is ceremony); the badge
   is the viewer's future summon point.
2. The viewer becomes worth building when correlated jobs multiply — i.e.
   alongside or after the workspace command plane epic.
3. Status-bar ownership unification (X-C slice) rides the same change.

## Cross-references

- Seed spec: `specs/2026-07-23-ask-panel-slash-commands-btw.md` (#55) —
  badge → popup lifecycle, JobTracker registration
- `extension-workspace-command-plane.md` — the sibling direction; the
  palette/viewer/switcher triad
- Job-engine design (2026-06-30, committed) — DescribeJob/ProcessorJob,
  worker pools per category
- TECH-DEBT X-C — status-bar job-UI split, unified by the viewer's owner
