import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const artifact = new URL('../plugin.js', import.meta.url)
const source = await readFile(artifact, 'utf8')
const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
const unsupported = imports.filter(specifier => !allowed.has(specifier))

if (unsupported.length > 0) {
  throw new Error(`plugin.js has unsupported runtime imports: ${unsupported.join(', ')}`)
}
if (!/export\s+default\s+plugin\s*$/.test(source)) {
  throw new Error('plugin.js must default-export the plugin')
}

const checked = spawnSync(process.execPath, ['--check', artifact.pathname], { encoding: 'utf8' })
if (checked.status !== 0) {
  process.stderr.write(checked.stderr)
  process.exit(checked.status ?? 1)
}

console.log(`Verified plugin.js (${Buffer.byteLength(source, 'utf8')} bytes, ${imports.length} allowed imports).`)
