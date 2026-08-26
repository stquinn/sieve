# How-To: Idiomatic JavaScript in Sieve

**Status:** Normative for all new JS (CLAUDE.md § Design Principles, 2026-07-08).
**Companion:** `design/specs/2026-07-08-workspace-editor-component-model.md`
(§ Design discipline) — the component architecture these idioms serve.

"Vanilla JS" is a **language choice** — plain JavaScript, no React/JSX/
TypeScript. Build steps (esbuild, tailwind) and libraries are fine. The choice
is never an excuse for loose function bags: JS here is written with the same
OOP discipline as the Go side ("no loose/free functions; behaviour is a method
on the type that owns its data"). The pleasant surprise for a Go-shaped brain:
modern JS agrees with Go more than folklore suggests — interfaces are
structural in both, capability checks are idiomatic in both, composition roots
exist in both.

---

## 1. Objects: `class`, constructor, `#private`

```js
// editor.js — one class per file, file named for the class
export class Editor {
  #socket; #surface; #mode = 'wysiwyg';   // #private is REAL: reach-in throws

  constructor(tab, doc) {
    if (!doc?.uuid) throw new ContractViolation('Editor requires a document')
    …
  }

  static forPrompt(tab, name, content) { … }   // alternative constructors are
                                               // static factories — Go's NewX()
  get mode() { return this.#mode }
  setMode(m) { … }                             // behaviour on the owner
}
```

- `#private` fields for everything not on the public contract. A typo or a
  reach-in is a thrown error, not a silent `undefined`.
- Getters for derived/read-only state; methods for behaviour. No public
  mutable fields on components.
- **Never:** prototype fiddling, `Object.create`, closures returning object
  literals, `var self = this`. All legacy folklore.

## 2. Contracts — three layers (all three, each for its job)

JS has no `interface` keyword, but Go interfaces are *structural* — satisfied
by shape — and that is exactly what JSDoc + duck typing give you.

### 2a. Declaration: JSDoc `@typedef` (the `.go` interface block)

```js
// @ts-check
/**
 * @typedef {object} InputSurface
 * @property {(host: HTMLElement, doc: DocView) => void} mount
 * @property {() => void} unmount
 * @property {(msg: ServerOp) => void} applyServerOp
 */
```

With `// @ts-check` at the top of the file, `tsc --noEmit` enforces the shape
structurally — a surface missing `unmount` fails the check, exactly like a Go
type failing to satisfy an interface. Types live in comments; code stays JS.
**Mandatory on public contracts** (component APIs, listener signatures,
SelectionContext); encouraged everywhere.

### 2b. Shared behaviour + required overrides: abstract base class

```js
export class AbstractEditor {
  save() { … }                        // mode-agnostic, written once, inherited
  getSelectionContext() { … }

  _mountSurface() {                   // subclass MUST provide
    throw new ContractViolation(
      `${this.constructor.name} must implement _mountSurface()`)
  }
}
```

Runtime enforcement, loud failure, zero tooling.

### 2c. Optional capabilities: duck-typed boundary checks

The JS twin of the Go idiom you already use daily
(`s.Store.(interface{ SetMaxVersions(int) })`, the registry's `hasPrefix`):

```js
if (typeof surface.observeSelection === 'function') {
  surface.observeSelection(this.#model)
}
```

Check once at the boundary, then trust. Never sprinkle `typeof` checks through
call sites — that is the boundary leaking.

## 3. Value objects and enums: freeze at the factory

```js
export class SelectionContext {
  static #gen = 0
  /** @returns {Readonly<SelectionContextFields>} */
  static mint(fields) {
    return Object.freeze({ ...fields, generation: ++SelectionContext.#gen })
  }
}

export const Mode = Object.freeze({ WYSIWYG: 'wysiwyg', MARKDOWN: 'markdown' })
/** @typedef {typeof Mode[keyof typeof Mode]} ModeValue */
```

- Value objects are born frozen; mutation throws (ES modules are strict mode
  automatically). Consumers hold snapshots, never live references.
- Enums are frozen const objects + a JSDoc union so `setMode('markdwon')`
  fails the check.
- Copies via `structuredClone`; never hand-rolled deep copies.

## 4. Events: typed registration methods, never string channels

Registered listeners are the house event model (no `document.dispatchEvent`,
no global CustomEvents — a DOM broadcast is a global bus wearing event
clothing). The idiom is **named registration methods**, not a generic
`on('someString', fn)` — string channels are the bus in miniature:

```js
export class Workspace {
  #selectionListeners = []

  /** @param {(ctx: SelectionContext) => void} fn @returns {() => void} unsubscribe */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => { this.#selectionListeners = this.#selectionListeners.filter(l => l !== fn) }
  }
}
```

- Returning the unsubscribe function is the standard lifecycle idiom.
- The class's `on*` methods ARE the published event contract — enumerable by
  reading the class, greppable at every registration call site.
- One exception route exists by design: `contextMenuRequested` percolates
  Editor → Tab → Workspace — still via these registrations, never a broadcast.

## 5. Modules are the package DAG

- `import`/`export` per file. Export **classes, not instances**.
- Singletons (Workspace) are created once at the composition root — the JS
  equivalent of `service_provider.go` — and handed down, never grabbed from
  `window`.
- Nothing new on `window.*`. The import graph IS the dependency structure:
  greppable, cycle-checkable, the same discipline as the Go package DAG from
  the S-A split.

## 6. Errors: throw early, throw named

```js
export class ContractViolation extends Error {}
```

- Constructors validate their arguments and throw.
- Contract breaches are `ContractViolation`, not `undefined` limping through
  three files before something NPEs.
- Exceptions are JS's error discipline — use them where Go returns errors: at
  the boundary, immediately, with the offending thing named in the message.

## 7. The one genuine footgun: `this` binding

Passing a method as a callback detaches `this`. One rule kills it:
**arrow functions at registration sites**:

```js
workspace.onSelectionUpdate((ctx) => this.#refresh(ctx))   // ✓
workspace.onSelectionUpdate(this.#refresh)                 // ✗ detached this
```

## 8. Comments: source code is source code

**A doc comment is a straight definition and explanation of what you are looking
at — what it is, what it does, what it requires of a caller, what it guarantees.
That is all it is for.** History and archaeology belong in git, the design record
belongs in the issue, and durable prose belongs in `docs/`.

**The line is DEFINING versus NARRATING, not long versus short.** Prose that
DEFINES is valid at any length: what this is, the forms it takes, what a caller
must respect, a constraint that makes the obvious usage wrong, a deliberate
absence in the design. Prose that NARRATES is invalid at any length: how we got
here, what was rejected and why, what it used to be called, which issue or phase
moved it, why a reviewer's objection did not apply. Cut it even when it is two
sentences. So do not ask "is this too long"; ask **is this defining the thing, or
telling its story?**

**Keep:**

- **What it does**, in the fewest words that are still precise, and what a caller
  must or must not do.
- **The trap** — a constraint that makes the obvious usage wrong, as ONE SENTENCE
  stating the rule, never as the story of how it was found.
  *"`bytes` is stored as a STRING: attrs round-trip through JSON on paste and
  yaml.v3 writes a large float in exponent form, so a numeric attr silently
  becomes `1e+08` on the second save."* Without it the next author "fixes" the
  type and reintroduces the bug.
- **JSDoc types** (`@typedef` / `@param` / `@returns` / `@property`). These are
  load-bearing under `// @ts-check`; they are contract, not commentary.

**Delete:**

- **Provenance.** What it used to be, what replaced what, which issue or phase
  drove it, what a sibling file implements. `git log -p` answers all of it and
  stays true. A bare phase code (`P3.C`, `D-r.7`) points at a plan document that
  is archived or gone; an issue number inside a sentence that stands on its own
  is fine.
- **Design narrative.** Why this was chosen over an alternative, what the other
  approach would have cost, comparisons a caller does not need.
- **Restatement** — anything a competent reader takes straight from the code.
- **Ceremonial banners**, and CAPITALS used for rhetoric rather than a real
  warning.

**If you find yourself writing what would be considered prose in a code comment,
either the code is too complex and warrants the essay, or you are writing in the
wrong place.** That diagnostic applies to the narrating kind only, never to a
definition: either the code needs simplifying, or the thought belongs in `docs/`
or the issue.

JSDoc and `// @ts-check` annotations stay, however verbose — types, parameters
and returns ARE the contract. Verbosity in service of the contract is not the
problem; stories are.

`sieve/domain/address.go`'s type godoc is the calibration example: twenty lines,
every one of them defining.

### Running a comment pass

Four things that are not obvious until a pass has gone wrong:

**Delete the block; do not shorten it.** The instinct is to rewrite prose more
tersely, and it under-delivers by roughly half: the #104 pass got 18% off its worst
file that way, and 42% once it started deleting. If a block fails *"would a
competent reader get this WRONG without it?"*, it does not exist in a shorter form —
it does not exist. A doc comment over `markDirty()` that says "Marks the document
dirty" goes; it does not become "Marks it dirty".

**Know the floor before chasing a number.** Comment lines are three different
things, and only one is discretionary:

| | example | discretionary? |
|---|---|---|
| tags | `@param`, `@returns`, `@type`, `@typedef` | no — load-bearing under `// @ts-check` |
| scaffolding | `/**`, ` */`, blank ` *` separators | no — implied by the tags |
| prose | everything else | **yes — this is the target** |

A types-only file legitimately reads 90% comment; `contract/` is four files with 23
lines of code between them and is correct as it stands. Measure prose against code,
never total comment against code, and never delete a tag to move a percentage.

**Template-literal contents are STRING DATA, not comments.** The CSS inside
`export const fooStyles = \`…\`` is emitted verbatim; editing it changes the
stylesheet. In a `*.styles.js` only the header above the export is a comment. Two
independent agents tripped on this in one afternoon.

**Verify mechanically, three ways.** A comment pass claims to change no behaviour,
so prove it rather than asserting it:

1. **esbuild byte-identity** — minify each in-scope file with
   `--minify --legal-comments=none` and compare the hash before and after. Comments
   are stripped, so an identical hash means nothing but comments moved. This catches
   a truncated JSDoc that swallowed the line below it.
2. **`tsc --noEmit` error-set identity** — diff the *set* of errors, not the count.
   Byte-identity CANNOT catch a broken type, because types are comments; only the
   type-checker can.
3. **The test suite.**

Any one alone is insufficient: (1) is blind to types, (2) is blind to logic, (3) is
blind to whatever is untested.

**Never write a comment to answer a code review.** If a reviewer asks "why not
X", the answer goes in the issue or the design doc. Each defence is individually
reasonable; the accumulation leaves a file arguing with a reviewer instead of
telling a caller what to do.

**The test for any comment: would a competent reader get this WRONG without it?**
If no, delete it.

### Worked example

`ai/ai-target.js` carried 21 lines of comment over 5 lines of code. Most of it
recorded that `resolveAiTarget` *used to* live there and which phase moved it —
true, useless to a reader, and already in git. What earns its place is only the
part explaining why the position is `sel.$to.after(1)` rather than `sel.to`: an
answer must land as a SIBLING of the enclosing top-level block instead of
splitting the paragraph.

Note the failure mode that produced files like it: *"match the surrounding
comment density"* propagates the worst example in the file's neighbourhood.
Match the surrounding *idiom*; judge comments one at a time against the test
above.

Although this document is the normative one for JavaScript, this section is
language-neutral and applies to the Go equally.

## 9. Enforcement (build steps are allowed — use them)

- `// @ts-check` per file + `tsc --noEmit` in CI: machine-checks every JSDoc
  contract without emitting anything or requiring TypeScript authorship.
- ESLint with a minimal config (`no-var`, `eqeqeq`, `prefer-const`,
  `no-implicit-globals`): the discipline becomes enforced, not aspirational.

## 10. What dies (quarantined debt, not precedent — X-C, epic #31)

| Anti-pattern | Replacement |
|---|---|
| IIFE assembling functions onto `window.TipTap` / `window.Sieve*` | `class` + ES module export |
| State as module-scope `var` (`currentEditor`, `tabModes`, …) | `#private` fields on the owning component |
| `document.dispatchEvent(new CustomEvent('sieve:*'))` | typed registration methods / direct API calls |
| Hand-rolled context objects bubbled with events | frozen `SelectionContext` via pull or push |
| `window.getSelection()` / `activeElement` peeking outside the SelectionModel | `getSelectionContext()` |
| String-switch pseudo-types (`context.type === 'aiBlock'`) | JSDoc-typed unions + capability checks |

Existing code in these shapes is migrated per epic #31's phases; new code in
these shapes fails review.
