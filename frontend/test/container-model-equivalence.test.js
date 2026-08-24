// @ts-check
// container-model-equivalence.test.js — recorded frame sequences, folded into the
// container model and held against frozen expectations (issue #96).
//
// The fixtures were FROZEN FROM THE OLD PATH: the same recorded wire traffic was
// played into a real ContainerTransport's block cache — the oracle — and its answers
// were written down. That oracle is gone with the cutover; these expectations are
// what it left behind, which is the whole reason they were frozen rather than
// computed live. What they pin is that the follower model reproduces the cache's
// account of a container, block for block, from real traffic.
//
// Two divergences from the oracle were DELIBERATE and are recorded in the
// fixtures rather than papered over:
//
//  1. The graveyard. The cache's index was sticky — a block a transform replaced,
//     or a reseed retired, stayed in it so an undo could still route. That was
//     transport bookkeeping; the model holds what the CONTAINER holds, so it drops
//     both. `oracleOnlyIds` names the difference, and the model must answer null
//     for every one of them.
//  2. `kind` inside the attrs bag. The cache's load path stamped `kind` into the
//     envelope payload and its render-back path did not. The model keeps kind on
//     the node and out of the opaque bag, uniformly — so the fixtures' payloads
//     carry the key and the model's attrs do not.

import { describe, it, expect } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'

import seq1 from './fixtures/container-frames/seq-1-job-lifecycle.json'
import seq1Expected from './fixtures/container-frames/seq-1-job-lifecycle.expected.json'
import seq2 from './fixtures/container-frames/seq-2-paste-inserts.json'
import seq2Expected from './fixtures/container-frames/seq-2-paste-inserts.expected.json'
import seq3 from './fixtures/container-frames/seq-3-transform-and-reseed.json'
import seq3Expected from './fixtures/container-frames/seq-3-transform-and-reseed.expected.json'

/** @type {Array<{sequence: any, expected: any}>} */
const SEQUENCES = [
  { sequence: seq1, expected: seq1Expected },
  { sequence: seq2, expected: seq2Expected },
  { sequence: seq3, expected: seq3Expected },
]

/** Plays a recorded sequence through the model.
 *  @param {any} sequence @returns {ContainerModel} */
function playModel(sequence) {
  const model = new ContainerModel(sequence.uuid)
  for (const step of sequence.steps) {
    if (step.load) model.applyLoad(step.load)
    else model.applyFrame(step.frame)
  }
  return model
}

/** A frozen oracle payload as the model holds it — see divergence 2 above.
 *  @param {Record<string, any>} payload @returns {Record<string, any>} */
function withoutKind(payload) {
  const copy = Object.assign({}, payload)
  delete copy.kind
  return copy
}

describe.each(SEQUENCES)('recorded sequence: $sequence.name', ({ sequence, expected }) => {
  it('the model folds to the frozen expected state', () => {
    const model = playModel(sequence)
    expect(model.getOrder()).toEqual(expected.order)
    for (const id of expected.order) {
      expect(model.getBlock(id)).toEqual(expected.blocks[id])
    }
    for (const id of expected.oracleOnlyIds) {
      expect(model.getBlock(id)).toBeNull()
    }
  })

  it('agrees with the frozen oracle on every block the container still holds', () => {
    const model = playModel(sequence)
    for (const id of model.getOrder()) {
      const node = model.getBlock(id)
      const entry = expected.oracleEnvelopes[id]
      expect(entry, id + ' is in the container but the oracle never held it').toBeTruthy()
      expect(node.kind).toBe(entry.kind)
      expect(node.attrs).toEqual(withoutKind(entry.payload))
    }
  })

  it('drops exactly the ids the old cache kept for routing and the container does not hold', () => {
    const model = playModel(sequence)
    for (const id of expected.oracleOnlyIds) {
      expect(expected.oracleEnvelopes[id], id + ' should be in the frozen oracle').toBeTruthy()
      expect(model.getBlock(id), id + ' should have left the container').toBeNull()
    }
  })

  it('the fixture itself is coherent — every expected block is in the order', () => {
    expect(Object.keys(expected.blocks).sort()).toEqual([...expected.order].sort())
    for (const id of expected.oracleOnlyIds) {
      expect(expected.order).not.toContain(id)
      expect(expected.oracleEnvelopes[id]).not.toBeNull()
    }
  })
})
