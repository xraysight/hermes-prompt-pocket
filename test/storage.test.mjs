import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs'
import { loadPlugin } from './helpers/load-plugin.mjs'

const DB = 'prompt-pocket'
const STORE = 'documents'
const KEY = 'library'
const ID_A = '10000000-0000-4000-8000-000000000001'
const ID_B = '10000000-0000-4000-8000-000000000002'
const ID_C = '10000000-0000-4000-8000-000000000003'
const T0 = '2026-09-21T10:00:00.000Z'
const T1 = '2026-09-21T11:00:00.000Z'

function prompt(id, name = 'Prompt', text = 'text', updatedAt = T0) {
  return { id, name, text, createdAt: T0, updatedAt }
}

test('missing storage is empty while malformed storage fails closed and is not overwritten', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  const store = new api.IndexedDbDocumentStore(indexedDB)

  assert.deepEqual(JSON.parse(JSON.stringify(await store.read())), { schemaVersion: 1, prompts: [] })
  store.close()

  indexedDB.seed(DB, STORE, KEY, { schemaVersion: 1, prompts: 'broken' })
  const malformedStore = new api.IndexedDbDocumentStore(indexedDB)
  await assert.rejects(malformedStore.read(), error => error.code === 'malformed-storage')
  await assert.rejects(malformedStore.mutate(() => ({ schemaVersion: 1, prompts: [] })), error => error.code === 'malformed-storage')
  assert.equal(indexedDB.raw(DB, STORE, KEY).prompts, 'broken')
})

test('a present undefined IndexedDB value is corrupt, not a missing document', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, undefined)
  const store = new api.IndexedDbDocumentStore(indexedDB)

  await assert.rejects(store.read(), error => error.code === 'malformed-storage')
  await assert.rejects(store.mutate(() => ({ schemaVersion: 1, prompts: [] })), error => error.code === 'malformed-storage')
  assert.equal(indexedDB.raw(DB, STORE, KEY), undefined)
})

test('unsupported IndexedDB reports a distinct closed failure', async () => {
  const { namespace: api } = await loadPlugin()
  const store = new api.IndexedDbDocumentStore(undefined)
  await assert.rejects(store.read(), error => error.code === 'storage-unsupported')
})

test('CRUD preserves exact text and enforces stale edit/delete checks', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  let timestamp = T0
  const repository = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), {
    makeUuid: () => ID_A,
    now: () => timestamp
  })
  const exact = '  first\nsecond 🧪\n'
  const created = await repository.create('  Named  ', exact)
  assert.equal(created.prompt.name, 'Named')
  assert.equal(created.prompt.text, exact)

  const staleSnapshot = created.prompt
  timestamp = T1
  const unchanged = await repository.update(created.prompt, 'Named', exact)
  assert.equal(unchanged.prompt.updatedAt, T0)
  const updated = await repository.update(unchanged.prompt, 'Renamed', `${exact}tail`)
  assert.equal(updated.prompt.id, ID_A)
  assert.equal(updated.prompt.createdAt, T0)
  assert.equal(updated.prompt.updatedAt, T1)
  await assert.rejects(repository.update(staleSnapshot, 'Lost update', 'no'), error => error.code === 'stale-edit')
  await assert.rejects(repository.delete(staleSnapshot), error => error.code === 'stale-edit')
  await repository.delete(updated.prompt)
  assert.equal((await repository.read()).prompts.length, 0)
})

test('failed put is atomic and does not publish a changed callback', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, { schemaVersion: 1, prompts: [prompt(ID_A)] })
  let changes = 0
  const repository = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), {
    makeUuid: () => ID_B,
    now: () => T1,
    onChanged: () => {
      changes += 1
    }
  })
  const before = indexedDB.raw(DB, STORE, KEY)
  indexedDB.failPut(DB)

  await assert.rejects(repository.create('Second', 'body'), error => error.code === 'storage-failure')
  assert.deepEqual(indexedDB.raw(DB, STORE, KEY), before)
  assert.equal(changes, 0)
})

test('cross-connection read-modify-write transactions serialize concurrent creates', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  const first = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), { makeUuid: () => ID_A, now: () => T0 })
  const second = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), { makeUuid: () => ID_B, now: () => T0 })

  await Promise.all([first.create('First', 'one'), second.create('Second', 'two')])
  const ids = (await first.read()).prompts.map(item => item.id).sort()
  assert.deepEqual(Array.from(ids), [ID_A, ID_B])
})

test('cross-connection stale edits are rejected after another window commits', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, { schemaVersion: 1, prompts: [prompt(ID_A)] })
  const first = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), { now: () => T1 })
  const second = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), { now: () => T1 })
  const snapshot = (await second.read()).prompts[0]

  await first.update(snapshot, 'Window one', 'changed')
  await assert.rejects(second.update(snapshot, 'Window two', 'other'), error => error.code === 'stale-edit')
  assert.equal((await second.read()).prompts[0].name, 'Window one')
})

test('import preview is non-mutating; apply is atomic and snapshot-stale aware', async () => {
  const { namespace: api } = await loadPlugin()
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, { schemaVersion: 1, prompts: [prompt(ID_A)] })
  const repository = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), {
    makeUuid: () => ID_C,
    now: () => T1
  })
  const imported = { schemaVersion: 1, prompts: [prompt(ID_B, 'Imported', 'body')] }
  const preview = await repository.previewImport(JSON.stringify(imported))
  assert.equal((await repository.read()).prompts.length, 1, 'cancelling after preview changes nothing')

  const other = new api.PromptRepository(new api.IndexedDbDocumentStore(indexedDB), { makeUuid: () => ID_C, now: () => T1 })
  await other.create('Concurrent', 'addition')
  await assert.rejects(repository.applyImport(preview.incoming, preview.current), error => error.code === 'stale-edit')
  assert.equal((await repository.read()).prompts.some(item => item.id === ID_B), false)

  const fresh = await repository.previewImport(JSON.stringify(imported))
  const applied = await repository.applyImport(fresh.incoming, fresh.current)
  assert.equal(applied.additions, 1)
  assert.equal((await repository.read()).prompts.some(item => item.id === ID_B), true)
})
