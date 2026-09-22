import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const chrome = process.env.CHROME_BIN || 'google-chrome'
const source = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')
const start = source.indexOf('export const DATABASE_NAME')
const end = source.indexOf('function readableError')
if (start < 0 || end < 0) throw new Error('Could not locate the testable storage section in plugin.js')
const core = source.slice(start, end).replace(/^export\s+/gm, '')
const temporary = await mkdtemp(join(tmpdir(), 'prompt-pocket-browser-'))
const htmlPath = join(temporary, 'index.html')
const profilePath = join(temporary, 'chrome-profile')

const check = String.raw`
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const idA = '20000000-0000-4000-8000-000000000001'
const idB = '20000000-0000-4000-8000-000000000002'
const t0 = '2026-09-21T10:00:00.000Z'
const t1 = '2026-09-21T11:00:00.000Z'

async function run() {
  const firstStore = new IndexedDbDocumentStore(indexedDB)
  const secondStore = new IndexedDbDocumentStore(indexedDB)
  const missing = await firstStore.read()
  assert(missing.prompts.length === 0, 'missing document was not empty')

  const first = new PromptRepository(firstStore, { makeUuid: () => idA, now: () => t0 })
  const second = new PromptRepository(secondStore, { makeUuid: () => idB, now: () => t0 })
  const exact = '  Żółw 🧪\nline two\n'
  await Promise.all([first.create('First', exact), second.create('Second', 'two')])
  const afterConcurrent = await first.read()
  assert(afterConcurrent.prompts.length === 2, 'concurrent transaction lost an update')
  assert(afterConcurrent.prompts.find(item => item.id === idA).text === exact, 'exact Unicode text changed')

  const stale = afterConcurrent.prompts.find(item => item.id === idA)
  const editorOne = new PromptRepository(firstStore, { now: () => t1 })
  const editorTwo = new PromptRepository(secondStore, { now: () => t1 })
  await editorOne.update(stale, 'Changed', exact)
  let staleRejected = false
  try { await editorTwo.update(stale, 'Lost', 'overwrite') } catch (error) { staleRejected = error.code === 'stale-edit' }
  assert(staleRejected, 'stale edit was not rejected')

  const beforeAbort = serializeDocument(await first.read())
  let invalidRejected = false
  try { await firstStore.mutate(() => ({ schemaVersion: 1, prompts: 'invalid' })) } catch { invalidRejected = true }
  assert(invalidRejected, 'invalid whole-document write did not reject')
  assert(serializeDocument(await first.read()) === beforeAbort, 'aborted transaction changed storage')

  firstStore.close()
  secondStore.close()
  const reopenedStore = new IndexedDbDocumentStore(indexedDB)
  assert(serializeDocument(await reopenedStore.read()) === beforeAbort, 'reopening lost committed data')
  reopenedStore.close()
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  await new Promise((resolve, reject) => {
    const tx = raw.transaction(DOCUMENT_STORE, 'readwrite')
    tx.objectStore(DOCUMENT_STORE).put({ schemaVersion: 1, prompts: 'corrupt' }, DOCUMENT_KEY)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  raw.close()
  let malformedRejected = false
  const malformedStore = new IndexedDbDocumentStore(indexedDB)
  try { await malformedStore.read() } catch (error) { malformedRejected = error.code === 'malformed-storage' }
  assert(malformedRejected, 'malformed document was treated as missing')
  malformedStore.close()
  const reopened = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  await new Promise((resolve, reject) => {
    const tx = reopened.transaction(DOCUMENT_STORE, 'readwrite')
    tx.objectStore(DOCUMENT_STORE).put(undefined, DOCUMENT_KEY)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  reopened.close()
  const undefinedStore = new IndexedDbDocumentStore(indexedDB)
  for (const operation of [() => undefinedStore.read(), () => undefinedStore.mutate(() => emptyDocument())]) {
    let rejected = false
    try { await operation() } catch (error) { rejected = error.code === 'malformed-storage' }
    assert(rejected, 'present undefined record was treated as missing')
  }
  undefinedStore.close()
}

run().then(() => {
  document.body.dataset.status = 'pass'
  document.body.textContent = 'Prompt Pocket real Chromium IndexedDB checks passed.'
}).catch(error => {
  document.body.dataset.status = 'fail'
  document.body.textContent = error && error.stack ? error.stack : String(error)
})
`

await writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><title>Prompt Pocket browser check</title><body data-status="running">running</body><script type="module">${core}\n${check}</script>`)

let child
let socket
try {
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profilePath}`, '--remote-debugging-port=0', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let launchError
  child.on('error', error => { launchError = error })
  let port
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (launchError) throw launchError
    try { port = (await readFile(join(profilePath, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch {}
    await delay(100)
  }
  if (!port) throw new Error('Chrome debugging endpoint did not start')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`file://${htmlPath}`)}`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data)
    if (pending.has(reply.id)) { pending.get(reply.id)(reply); pending.delete(reply.id) }
  })
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')) }, 5000)
    pending.set(id, reply => { clearTimeout(timer); resolve(reply.result?.result?.value) })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  let status
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = await evaluate('document.body?.dataset.status')
    if (status === 'pass' || status === 'fail') break
    await delay(100)
  }
  if (status !== 'pass') throw new Error(`Chromium check ${status}: ${await evaluate('document.body?.textContent')}`)
  console.log('Real Chromium IndexedDB checks passed (headless browser, not Hermes Desktop).')
} finally {
  socket?.close()
  if (child && child.exitCode === null && child.pid) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  await rm(temporary, { recursive: true, force: true })
}
