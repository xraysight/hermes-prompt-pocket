import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const forbidden = [
  ['ctx.storage', /\bctx\.storage\b/],
  ['gateway requests', /\bhost\.request(?:Profile)?\b/],
  ['plugin REST', /\bctx\.rest\b/],
  ['plugin sockets', /\bctx\.socket\b/],
  ['browser fetch', /\bfetch\s*\(/],
  ['composer middleware', /COMPOSER_AREAS\.middleware/],
  ['draft replacement', /\b(set|replace|insert)Composer(?:Draft|Text)\b/]
]

const violations = forbidden.filter(([, pattern]) => pattern.test(source)).map(([label]) => label)
if (violations.length > 0) throw new Error(`Forbidden runtime capabilities found: ${violations.join(', ')}`)
if (!source.includes("defaults: []")) throw new Error('Expected explicitly unbound rebindable commands')
if (!source.includes("ctx.onDispose")) throw new Error('Expected unload cleanup')
if (!source.includes("ctx.os.writeClipboard")) throw new Error('Expected the public clipboard API')

console.log('Static policy checks passed.')
