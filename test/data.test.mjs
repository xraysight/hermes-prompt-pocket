import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

const ID_A = '00000000-0000-4000-8000-000000000001'
const ID_B = '00000000-0000-4000-8000-000000000002'
const ID_C = '00000000-0000-4000-8000-000000000003'
const T0 = '2026-09-21T10:00:00.000Z'
const T1 = '2026-09-21T11:00:00.000Z'

function record(id, name, text, createdAt = T0, updatedAt = T0) {
  return { id, name, text, createdAt, updatedAt }
}

test('validation and JSON round trip preserve exact Unicode multiline whitespace', async () => {
  const { namespace: api } = await loadPlugin()
  const text = '  Zażółć 🧪\nsecond line\n'
  const document = { schemaVersion: 1, prompts: [record(ID_A, 'Unicode', text)] }
  const serialized = api.serializeDocument(document)
  const parsed = api.parseImport(serialized)

  assert.equal(parsed.prompts[0].text, text)
  assert.equal(parsed.prompts[0].text.length, text.length)
  assert.equal(serialized.endsWith('\n'), true)
})

test('validation rejects unknown fields, duplicate IDs, blank text, and unsupported schemas', async () => {
  const { namespace: api } = await loadPlugin()
  const cases = [
    { schemaVersion: 1, prompts: [{ ...record(ID_A, 'One', 'text'), extra: true }] },
    { schemaVersion: 1, prompts: [record(ID_A, 'One', 'text'), record(ID_A, 'Again', 'other')] },
    { schemaVersion: 1, prompts: [record(ID_A, 'One', ' \n ')] },
    { schemaVersion: 2, prompts: [] }
  ]

  for (const value of cases) {
    assert.throws(() => api.parseImport(JSON.stringify(value)), error => error.code === 'invalid-import')
  }
})

test('search matches name or text case-insensitively and sorts deterministically', async () => {
  const { namespace: api } = await loadPlugin()
  const document = {
    schemaVersion: 1,
    prompts: [
      record(ID_B, 'Beta', 'Needle in contents', T0, T1),
      record(ID_C, 'needle title', 'elsewhere', T0, T1),
      record(ID_A, 'Alpha', 'none', T0, T0)
    ]
  }

  assert.deepEqual(Array.from(api.searchPrompts(document, 'NEEDLE'), prompt => prompt.id), [ID_B, ID_C])
  assert.deepEqual(Array.from(api.searchPrompts(document, ''), prompt => prompt.id), [ID_B, ID_C, ID_A])
})

test('additive import skips identical IDs, copies collisions, and does not mutate its inputs', async () => {
  const { namespace: api } = await loadPlugin()
  const current = {
    schemaVersion: 1,
    prompts: [record(ID_A, 'Same', 'same'), record(ID_B, 'Existing', 'original')]
  }
  const incoming = {
    schemaVersion: 1,
    prompts: [record(ID_A, 'Same', 'same'), record(ID_B, 'Incoming', 'different'), record(ID_C, 'New', 'new')]
  }
  const before = JSON.stringify(current)
  const copyId = '00000000-0000-4000-8000-000000000099'
  const plan = api.planImport(current, incoming, () => copyId)

  assert.equal(plan.additions, 2)
  assert.equal(plan.skipped, 1)
  assert.equal(plan.collisionCopies, 1)
  assert.equal(plan.document.prompts.length, 4)
  assert.equal(plan.document.prompts.some(prompt => prompt.id === copyId && prompt.name === 'Incoming'), true)
  assert.equal(JSON.stringify(current), before)
})

test('import reserves later incoming IDs before generating collision-copy IDs', async () => {
  const { namespace: api } = await loadPlugin()
  const current = { schemaVersion: 1, prompts: [record(ID_A, 'Existing', 'original')] }
  const incoming = {
    schemaVersion: 1,
    prompts: [record(ID_A, 'Collision', 'different'), record(ID_B, 'Later', 'incoming')]
  }
  const generated = [ID_B, ID_C]
  const plan = api.planImport(current, incoming, () => generated.shift())

  assert.equal(plan.collisionCopies, 1)
  assert.deepEqual(Array.from(plan.document.prompts, prompt => prompt.id), [ID_A, ID_C, ID_B])
})
