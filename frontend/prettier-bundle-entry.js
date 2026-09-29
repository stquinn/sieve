// The browser Prettier bundle: `format` plus every plugin the formatter's
// language table names. Bundled to src/static/vendor/prettier.js by
// `npm run bundle:prettier`, and loaded by renderers/prettier-formatter.js on
// the first Format — never from index.html.
//
// ESM, not IIFE: prettier-plugin-java's Java parser is WebAssembly and locates
// its two .wasm files through `new URL(name, import.meta.url)`, so the bundle
// must keep import.meta and the .wasm files must sit beside it in vendor/.
export { format } from 'prettier/standalone'

import * as babel from 'prettier/plugins/babel'
import * as estree from 'prettier/plugins/estree'
import * as yaml from 'prettier/plugins/yaml'
import java from 'prettier-plugin-java'

export const plugins = [babel, estree, yaml, java]
