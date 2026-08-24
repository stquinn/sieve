// @ts-check
// fake-host.js — FakeHost: the smallest thing that can host a lens.
//
// A ContainerModel, a ProviderAdapter over it, a DOM element to mount into and
// a recording SelectionListener. No workspace, no transport, no socket, no Go
// process — which is the claim being tested: a lens needs a host, and a host
// needs to be none of those things.
//
// It plays the SAME recorded frame fixtures the model's own suites use
// (test/fixtures/container-frames/), so a lens is driven by real wire traffic
// rather than by shapes invented for it.

import { ContainerModel } from '../../src/static/container/container-model.js'
import { ProviderAdapter } from '../../src/static/container/provider-adapter.js'

export class FakeHost {
  /** @type {ContainerModel} */ #model
  /** @type {ProviderAdapter} */ #provider
  /** @type {any[]} */ #adverts = []

  /** @param {string} uuid @param {string} [kind] */
  constructor(uuid, kind) {
    this.#model = new ContainerModel(uuid, kind)
    this.#provider = new ProviderAdapter(this.#model)
  }

  /** The one thing a lens is constructed with. @returns {any} */
  get provider() { return this.#provider }

  /** Every advertisement this host has heard, oldest first. @returns {any[]} */
  get adverts() { return this.#adverts }

  /** @returns {any} */
  get lastAdvert() { return this.#adverts.length ? this.#adverts[this.#adverts.length - 1] : null }

  /** SelectionListener — the host is the presence consumer.
   *  @param {any} context */
  onSelectionChanged(context) { this.#adverts.push(context) }

  /** Mounts a lens into a fresh element and registers this host for presence.
   *  @param {any} lens @returns {HTMLElement} the element the lens paints into */
  mount(lens) {
    const element = document.createElement('div')
    lens.setSelectionListener(this)
    lens.mount(element)
    return element
  }

  /** Plays one recorded step — a load answer or a document-channel frame.
   *  @param {{load?: any, frame?: any}} step */
  play(step) {
    if (step.load) this.#model.applyLoad(step.load)
    else this.#model.applyFrame(step.frame)
  }

  /** @param {{steps: Array<{load?: any, frame?: any}>}} sequence */
  playAll(sequence) { for (const step of sequence.steps) this.play(step) }

  /** Registers an extra listener — how a test proves a frame really was folded
   *  when the lens under test is supposed to have stopped listening.
   *  @param {{onChanged: (change: any) => void}} listener */
  subscribe(listener) { this.#model.subscribe(listener) }
}
