import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './helpers/load-plugin.mjs'
import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs'

const ID = '40000000-0000-4000-8000-000000000001'
const TIME = '2026-09-21T10:00:00.000Z'
const exact = '  Żółw 🧪\r\n<script>alert(1)</script>\n\t'
const record = { id: ID, name: 'QA prompt', text: exact, createdAt: TIME, updatedAt: TIME }
const document = { schemaVersion: 1, prompts: [record] }

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}
function find(tree, predicate) {
  const result = nodes(tree).find(predicate)
  assert.ok(result, 'Expected component node')
  return result
}
const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve() }

for (const fail of [false, true]) {
  test(`delete lifecycle: delayed commit ${fail ? 'failure and retry' : 'success'} (SDK behavior/IDB fixtures)`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const other = { ...record, id: '40000000-0000-4000-8000-000000000002', name: 'Other' }
    const stored = { schemaVersion: 1, prompts: [record, other] }
    const q = await setup({ stored })
    try {
      const surface = q.open('prompt-pocket.open-library')
      q.hooks.render(surface, 'library')
      await flush()
      let tree = q.hooks.render(surface, 'library')
      q.button(tree, 'Delete').props.onClick()
      const render = () => {
        tree = q.hooks.render(surface, 'library')
        return q.hooks.render(find(tree, n => n.type === q.sdk.ConfirmDialog), 'confirm')
      }
      render()
      let confirmation = render()
      let release
      q.indexedDB.databases.get('prompt-pocket').writeTail = new Promise(resolve => { release = resolve })
      if (fail) q.indexedDB.failPut('prompt-pocket')
      const confirmProps = find(tree, n => n.type === q.sdk.ConfirmDialog).props
      const first = confirmProps.onConfirm()
      const repeated = confirmProps.onConfirm()
      // A repeated call must share the pending result, not resolve early and
      // trick the SDK into showing done/closing before the transaction settles.
      assert.equal(first, repeated)
      q.button(confirmation, 'Delete').props.onClick()
      confirmation = render()
      await flush()
      assert.equal(q.indexedDB.transactionCount('prompt-pocket', 'readwrite'), 1)
      assert.equal(q.button(confirmation, 'Delete').props.disabled, true)
      assert.equal(q.button(confirmation, 'Cancel').props.disabled, true)
      find(confirmation, n => n.type === q.sdk.Dialog).props.onOpenChange(false)
      find(confirmation, n => n.type === q.sdk.DialogContent).props.onKeyDown({ key: 'Enter', preventDefault() {} })
      confirmProps.onClose()
      find(tree, n => n.type === q.sdk.Dialog).props.onOpenChange(false)
      for (const label of ['Close', 'New prompt', 'Edit', 'Import JSON']) q.button(tree, label).props.onClick()
      q.open('prompt-pocket.open-library')
      assert.equal(q.hooks.render(q.controller, 'controller').type.name, 'LibraryDialog')
      assert.equal(render().props.open, true)
      t.mock.timers.tick(1000)
      assert.equal(render().props.open, true)
      assert.deepEqual(q.indexedDB.raw('prompt-pocket', 'documents', 'library'), stored)
      const outcome = Promise.allSettled([first, repeated])
      release()
      await outcome
      await flush()
      confirmation = render()
      if (fail) {
        assert.equal(confirmation.props.open, true)
        assert.match(find(confirmation, n => n.type === 'span').props.children, /write/)
        assert.equal(q.button(confirmation, 'Delete').props.disabled, false)
        assert.deepEqual(q.indexedDB.raw('prompt-pocket', 'documents', 'library'), stored)
        assert.equal(q.calls.notifications.length, 0)
        q.button(confirmation, 'Delete').props.onClick()
        await flush()
        confirmation = render()
      }
      assert.deepEqual(q.indexedDB.raw('prompt-pocket', 'documents', 'library').prompts, [other])
      assert.equal(q.indexedDB.transactionCount('prompt-pocket', 'readwrite'), fail ? 2 : 1)
      assert.equal(q.calls.notifications.length, 1)
      t.mock.timers.tick(600)
      assert.equal(render().props.open, false)
      q.button(tree, 'Close').props.onClick()
      assert.equal(q.hooks.render(q.controller, 'controller'), null)
    } finally {
      q.hooks.unmount('confirm')
      q.dispose()
    }
  })
}

async function setup({ clipboard = async () => true, stored = document } = {}) {
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed('prompt-pocket', 'documents', 'library', stored)
  const loaded = await loadPlugin({ indexedDB, crypto: { randomUUID: () => ID } })
  const contributions = []
  let dispose
  loaded.namespace.default.register({
    registerMany: items => contributions.push(...items),
    onDispose: callback => { dispose = callback },
    os: { writeClipboard: clipboard }
  })
  const controller = contributions.find(item => item.id === 'dialog-controller').render()
  loaded.hooks.render(controller, 'controller')
  const open = id => {
    contributions.find(item => item.area === 'palette' && item.data.id === id).data.run()
    return loaded.hooks.render(controller, 'controller')
  }
  const button = (tree, label) => find(tree, node => node.type === loaded.sdk.Button && node.props.children === label)
  return { ...loaded, indexedDB, controller, dispose, open, button }
}

for (const mode of ['success', 'false', 'throw']) {
  test(`QA clipboard ${mode}: exact prompt and export, no send (SDK fixture)`, async () => {
    const copied = []
    const q = await setup({ clipboard: async text => {
      copied.push(text)
      if (mode === 'throw') throw new Error('clipboard denied')
      return mode === 'success'
    } })
    try {
      const surface = q.open('prompt-pocket.open-library')
      q.hooks.render(surface, 'library')
      await flush()
      let tree = q.hooks.render(surface, 'library')
      const pre = find(tree, node => node.type === 'pre')
      assert.equal(pre.props.children, exact)
      assert.equal(pre.props.dangerouslySetInnerHTML, undefined)
      for (const [label, expected] of [
        ['Copy prompt', exact],
        ['Copy export JSON', q.namespace.serializeDocument(document)]
      ]) {
        q.button(tree, label).props.onClick()
        await flush()
        tree = q.hooks.render(surface, 'library')
        assert.equal(copied.at(-1), expected)
        const fallback = nodes(tree).find(node => node.type?.name === 'ManualCopy')
        if (mode === 'success') assert.equal(fallback, undefined)
        else {
          assert.equal(fallback.props.text, expected)
          const manualTree = q.hooks.render(fallback, 'manual')
          const area = find(manualTree, node => node.type === q.sdk.Textarea)
          assert.equal(area.props.value, expected)
          assert.equal(area.props.readOnly, true)
          let focused = 0
          let selected = 0
          area.props.ref.current = { focus: () => { focused += 1 }, select: () => { selected += 1 } }
          q.button(manualTree, 'Select text').props.onClick()
          assert.equal(focused, 1)
          assert.equal(selected, 1)
        }
      }
      assert.equal(q.calls.requests.length, 0)
      assert.equal(q.calls.notifications.length, mode === 'success' ? 2 : 0)
      assert.equal(q.indexedDB.transactionCount('prompt-pocket', 'readwrite'), 0)
    } finally { q.dispose() }
  })
}

test('QA editor rejects blanks and preserves input after failed save (SDK/IDB fixtures)', async () => {
  const q = await setup({ stored: { schemaVersion: 1, prompts: [] } })
  try {
    const library = q.open('prompt-pocket.open-library')
    q.button(q.hooks.render(library, 'library'), 'New prompt').props.onClick()
    const surface = q.hooks.render(q.controller, 'controller')
    let tree = q.hooks.render(surface, 'editor')
    const field = label => find(tree, node => node.props?.['aria-label'] === label)
    const submit = async () => {
      await find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
      tree = q.hooks.render(surface, 'editor')
    }
    await submit()
    assert.match(find(tree, node => node.type?.name === 'FieldError').props.message, /Name is required/)
    field('Prompt name').props.onChange({ target: { value: '  Name  ' } })
    field('Prompt text').props.onChange({ target: { value: ' \n\t' } })
    tree = q.hooks.render(surface, 'editor')
    await submit()
    assert.match(find(tree, node => node.type?.name === 'FieldError').props.message, /Prompt text is required/)
    assert.equal(q.indexedDB.transactionCount('prompt-pocket', 'readwrite'), 0)
    field('Prompt text').props.onChange({ target: { value: exact } })
    tree = q.hooks.render(surface, 'editor')
    q.indexedDB.failPut('prompt-pocket')
    await submit()
    assert.match(find(tree, node => node.type?.name === 'FieldError').props.message, /write/)
    assert.equal(field('Prompt text').props.value, exact)
    assert.equal(field('Prompt name').props.value, '  Name  ')
    assert.equal(q.hooks.render(q.controller, 'controller').type.name, 'EditorDialog')
    assert.equal(q.calls.notifications.length, 0)
    await submit()
    assert.equal(q.hooks.render(q.controller, 'controller').type.name, 'LibraryDialog')
    assert.equal(q.indexedDB.raw('prompt-pocket', 'documents', 'library').prompts[0].text, exact)
    assert.equal(q.indexedDB.raw('prompt-pocket', 'documents', 'library').prompts[0].name, 'Name')
  } finally { q.dispose() }
})

test('QA empty, no-match and malformed-library states (SDK fixture)', async () => {
  for (const stored of [{ schemaVersion: 1, prompts: [] }, document, { schemaVersion: 9, prompts: [] }]) {
    const q = await setup({ stored })
    try {
      const surface = q.open('prompt-pocket.open-library')
      q.hooks.render(surface, 'library')
      await flush()
      let tree = q.hooks.render(surface, 'library')
      if (stored.schemaVersion === 9) {
        assert.equal(find(tree, node => node.type === q.sdk.ErrorState).props.title, 'Prompt library unavailable')
        assert.equal(q.button(tree, 'Import JSON').props.disabled, true)
        assert.equal(q.button(tree, 'Copy export JSON').props.disabled, true)
      } else if (stored.prompts.length === 0) {
        assert.equal(find(tree, node => node.type === q.sdk.EmptyState).props.title, 'No saved prompts')
      } else {
        find(tree, node => node.type === q.sdk.SearchField).props.onChange('no-such-prompt')
        tree = q.hooks.render(surface, 'library')
        assert.equal(find(tree, node => node.type === q.sdk.EmptyState).props.title, 'No matches')
        assert.equal(nodes(tree).some(node => node.type === 'pre'), false)
      }
      assert.deepEqual(q.indexedDB.raw('prompt-pocket', 'documents', 'library'), stored)
      assert.equal(q.indexedDB.transactionCount('prompt-pocket', 'readwrite'), 0)
    } finally { q.dispose() }
  }
})

test('QA large Unicode prompt, literal search and invalid import boundaries (VM fixture)', async () => {
  const { namespace: api } = await loadPlugin()
  const large = { ...record, text: 'Ż🧪\r\n'.repeat(200000) }
  const value = { schemaVersion: 1, prompts: [large] }
  assert.equal(api.parseImport(api.serializeDocument(value)).prompts[0].text, large.text)
  assert.equal(api.searchPrompts(document, '<SCRIPT>').length, 1)
  assert.equal(api.searchPrompts(document, '.*').length, 0)
  for (const text of ['', 'null', '[]', '{', '{"schemaVersion":2,"prompts":[]}', JSON.stringify({ ...document, extra: true })]) {
    assert.throws(() => api.parseImport(text), error => error.code === 'invalid-import')
  }
  for (const patch of [{ id: 'not-a-uuid' }, { createdAt: 'yesterday' }, { updatedAt: '2020-01-01T00:00:00.000Z' }, { text: '\n\t' }, { name: ' ' }]) {
    assert.throws(() => api.parseImport(JSON.stringify({ schemaVersion: 1, prompts: [{ ...record, ...patch }] })), error => error.code === 'invalid-import')
  }
})
