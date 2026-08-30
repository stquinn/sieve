// @ts-check
// A REAL ProseMirror schema built from the node configs the live registry mints.
//
// The point is fidelity: the sieve half is not hand-written here, it is
// TRANSCRIBED from each adapter's own nodeConfig/attrs/parseHTML the way TipTap
// transcribes it, so a test parsing a block's data-* costume exercises the real
// schema decisions (which group a kind is in, what content it admits, whether
// its text is whitespace-preserving). Only the native prose half is written out,
// because in the app it comes from StarterKit.
//
// Use with `T.Node = { create: (cfg) => cfg }`: registration then hands back the
// raw node configs instead of TipTap nodes, and those are what this reads.

import { Schema } from '@tiptap/pm/model'

/** The native half — the document top level and the nodes markdown parses to. */
const NATIVE_NODES = {
  doc: { content: '(block | sieveBlock)+' },
  paragraph: {
    group: 'block', content: 'inline*', attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0],
  },
  heading: {
    group: 'block', content: 'inline*', attrs: { id: { default: '' }, level: { default: 1 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + level, attrs: { level } })),
    toDOM: (/** @type {any} */ n) => ['h' + n.attrs.level, 0],
  },
  bulletList: {
    group: 'block', content: 'listItem+', attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0],
  },
  orderedList: {
    group: 'block', content: 'listItem+', attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'ol' }], toDOM: () => ['ol', 0],
  },
  listItem: { content: 'paragraph block*', parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
  blockquote: {
    group: 'block', content: 'block+', attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0],
  },
  codeBlock: {
    group: 'block', content: 'text*', code: true, marks: '', attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'pre' }], toDOM: () => ['pre', ['code', 0]],
  },
  horizontalRule: {
    group: 'block', atom: true, attrs: { id: { default: '' } },
    parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'],
  },
  hardBreak: {
    group: 'inline', inline: true, selectable: false,
    parseDOM: [{ tag: 'br' }], toDOM: () => ['br'],
  },
  text: { group: 'inline' },
}

const NATIVE_MARKS = {
  em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
  strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  link: {
    attrs: { href: { default: '' } },
    parseDOM: [{ tag: 'a[href]', getAttrs: (/** @type {any} */ el) => ({ href: el.getAttribute('href') }) }],
    toDOM: (/** @type {any} */ m) => ['a', { href: m.attrs.href }, 0],
  },
}

/**
 * One minted node config as the NodeSpec TipTap would have produced from it.
 * @param {any} cfg
 * @returns {any}
 */
function specOf(cfg) {
  const attrDefs = cfg.addAttributes()
  /** @type {Record<string, any>} */
  const attrs = {}
  for (const name of Object.keys(attrDefs)) attrs[name] = { default: attrDefs[name].default }
  return {
    group: cfg.group,
    atom: cfg.atom,
    selectable: cfg.selectable,
    draggable: cfg.draggable,
    content: cfg.content,
    marks: cfg.marks,
    code: cfg.code,
    defining: cfg.defining,
    attrs,
    parseDOM: cfg.parseHTML().map((/** @type {any} */ rule) => ({
      tag: rule.tag,
      getAttrs(/** @type {any} */ el) {
        /** @type {Record<string, any>} */
        const out = {}
        for (const name of Object.keys(attrDefs)) {
          out[name] = attrDefs[name].parseHTML ? attrDefs[name].parseHTML(el) : attrDefs[name].default
        }
        return out
      },
    })),
    toDOM: (/** @type {any} */ node) => (cfg.content
      ? ['div', { 'data-type': cfg.name, 'data-id': node.attrs.id }, 0]
      : ['div', { 'data-type': cfg.name, 'data-id': node.attrs.id }]),
  }
}

/**
 * The schema for a set of minted sieve node configs, alongside the native prose
 * nodes. Order matters: prose-first, as the live registry lists it.
 * @param {any[]} configs  what NodeViewRegistry.nodes() returned
 * @returns {import('@tiptap/pm/model').Schema}
 */
export function buildSieveSchema(configs) {
  /** @type {Record<string, any>} */
  const nodes = Object.assign({}, NATIVE_NODES)
  for (const cfg of configs) nodes[cfg.name] = specOf(cfg)
  return new Schema({ nodes, marks: NATIVE_MARKS })
}
