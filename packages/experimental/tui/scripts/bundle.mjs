// Emit the package entry points over tsc's per-module output. The repo's
// tsdown pass bundles in-box packages for npm; a private experimental bundle
// only needs stable `lib/index.js` and `lib/startup.js` specifiers.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
writeFileSync(join(lib, 'index.js'), "export * from './types/index.js'\n")
writeFileSync(join(lib, 'startup.js'), "export * from './types/startup.js'\n")
