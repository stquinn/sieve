// @ts-check
// The all-blocks renderer registry, POPULATED. Importing this module is what
// makes getBlockRenderer(kind) answer for every kind Sieve draws — each renderer
// module registers itself at the bottom of its own file, and this is the one
// place that guarantees they have all been loaded.
//
// A consumer that draws blocks whose kinds it does not know imports THIS and
// reads the registry; a consumer that draws one known kind imports that class
// directly. There is nothing else in here on purpose: it is a manifest.

import './ai-block-renderer.js'
import './code-renderer.js'
import './command-result-renderer.js'
import './diagram-renderer.js'
import './log-renderer.js'
import './prose-renderer.js'
import './reference-renderer.js'
import './smart-card-renderer.js'
import './smart-image-renderer.js'
import './web-clip-renderer.js'

export { getBlockRenderer, listInsertableKinds } from './block-kinds.js'
