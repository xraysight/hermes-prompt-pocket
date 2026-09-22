import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs'
import { loadPlugin } from './helpers/load-plugin.mjs'

const DB = 'prompt-pocket'
const STORE = 'documents'
const KEY = 'library'
const ID_A = '30000000-0000-4000-8000-000000000001'
const ID_B = '30000000-0000-4000-8000-000000000002'
const ID_C = '30000000-0000-4000-8000-000000000003'
const T0 = '2026-09-21T10:00:00.000Z'

function prompt(id, name, text) {
  return { id, name, text, createdAt: T0, updatedAt: T0 }
}

function visit(node, callback) {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback)
    return
  }
  if (!node || typeof node !== 'object') return
  callback(node)
  visit(node.props?.children, callback)
}

function findNode(tree, predicate, label) {
  let found = null
  visit(tree, node => {
    if (!found && predicate(node)) found = node
  })
  assert.ok(found, `Expected to find ${label}`)
  return found
}

function findNodes(tree, predicate) {
  const found = []
  visit(tree, node => {
    if (predicate(node)) found.push(node)
  })
  return found
}

async function flushAsync() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

function register(api, clipboard = async () => true) {
  const contributions = []
  const disposers = []
  api.default.register({
    registerMany(items) {
      contributions.push(...items)
      return () => undefined
    },
    onDispose(dispose) {
      disposers.push(dispose)
    },
    os: { writeClipboard: clipboard }
  })
  const controller = contributions.find(item => item.id === 'dialog-controller')
  const commands = Object.fromEntries(
    contributions
      .filter(item => item.area === 'palette')
      .map(item => [item.data.id, item.data.run])
  )
  return { commands, controllerElement: controller.render(), dispose: disposers[0] }
}

function input(tree, sdk, label) {
  return findNode(tree, node => node.type === sdk.Input && node.props['aria-label'] === label, label)
}

function textarea(tree, sdk, label) {
  return findNode(tree, node => node.type === sdk.Textarea && node.props['aria-label'] === label, label)
}

function dialog(tree, sdk) {
  return findNode(tree, node => node.type === sdk.Dialog, 'Dialog')
}

function confirmDialog(tree, sdk) {
  return findNode(tree, node => node.type === sdk.ConfirmDialog, 'ConfirmDialog')
}

test('external open intents do not replace dirty editor or import surfaces', async () => {
  const indexedDB = new FakeIndexedDB()
  const generated = [ID_A, ID_B, ID_C]
  const loaded = await loadPlugin({ crypto: { randomUUID: () => generated.shift() }, indexedDB })
  const { namespace: api, hooks, sdk } = loaded
  const registered = register(api)
  const controller = registered.controllerElement

  assert.equal(hooks.render(controller, 'controller'), null)
  registered.commands['prompt-pocket.open-library']()
  let surface = hooks.render(controller, 'controller')
  const libraryTree = hooks.render(surface, 'library')
  findNode(libraryTree, node => node.type === sdk.Button && node.props.children === 'New prompt', 'New prompt button').props.onClick()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'EditorDialog')
  let tree = hooks.render(surface, 'editor')
  input(tree, sdk, 'Prompt name').props.onChange({ target: { value: 'Unsaved editor' } })
  tree = hooks.render(surface, 'editor')

  registered.commands['prompt-pocket.open-library']()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'EditorDialog')
  tree = hooks.render(surface, 'editor')
  assert.equal(input(tree, sdk, 'Prompt name').props.value, 'Unsaved editor')

  dialog(tree, sdk).props.onOpenChange(false)
  tree = hooks.render(surface, 'editor')
  assert.equal(confirmDialog(tree, sdk).props.open, true)
  confirmDialog(tree, sdk).props.onConfirm()
  assert.equal(hooks.render(controller, 'controller'), null)

  registered.commands['prompt-pocket.open-library']()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'LibraryDialog')
  surface.props.onImport()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'ImportDialog')
  tree = hooks.render(surface, 'import')
  textarea(tree, sdk, 'Import JSON').props.onChange({ target: { value: '{ unsaved import' } })
  tree = hooks.render(surface, 'import')

  registered.commands['prompt-pocket.open-library']()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'ImportDialog')
  tree = hooks.render(surface, 'import')
  assert.equal(textarea(tree, sdk, 'Import JSON').props.value, '{ unsaved import')
  dialog(tree, sdk).props.onOpenChange(false)
  tree = hooks.render(surface, 'import')
  confirmDialog(tree, sdk).props.onConfirm()
  assert.equal(hooks.render(controller, 'controller'), null)

  registered.dispose()
})

test('controller clears an open intent as soon as it is consumed', async () => {
  const { namespace: api, hooks } = await loadPlugin()
  const registered = register(api)
  registered.commands['prompt-pocket.open-library']()

  const controller = registered.controllerElement
  assert.equal(hooks.render(controller, 'first-controller'), null)
  const consumed = hooks.render(controller, 'first-controller')
  assert.equal(consumed.type.name, 'LibraryDialog')
  hooks.unmount('first-controller')

  assert.equal(hooks.render(controller, 'replacement-controller'), null)
  assert.equal(hooks.render(controller, 'replacement-controller'), null)
  registered.dispose()
})

test('library option buttons support arrows and one Enter activation while unrelated buttons are ignored', async () => {
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, {
    schemaVersion: 1,
    prompts: [prompt(ID_A, 'First', 'first text'), prompt(ID_B, 'Second', 'second text')]
  })
  const copied = []
  const { namespace: api, hooks, sdk } = await loadPlugin({ indexedDB })
  const registered = register(api, async value => {
    copied.push(value)
    return true
  })
  const controller = registered.controllerElement
  hooks.render(controller, 'controller')
  registered.commands['prompt-pocket.open-library']()
  const surface = hooks.render(controller, 'controller')
  hooks.render(surface, 'library')
  await flushAsync()
  let tree = hooks.render(surface, 'library')
  const content = findNode(tree, node => typeof node.props?.onKeyDown === 'function', 'keyboard handler')
  const options = findNodes(tree, node => node.type === 'button' && node.props.role === 'option')
  assert.equal(options.length, 2)

  const focusCounts = new Map()
  const optionNodes = options.map(option => {
    const id = option.props['data-prompt-id']
    const node = {
      dataset: { promptId: id },
      focus() {
        focusCounts.set(id, (focusCounts.get(id) ?? 0) + 1)
      },
      getAttribute(name) {
        return name === 'role' ? 'option' : null
      },
      closest(selector) {
        return selector === '[role="option"]' || selector === 'button' ? this : null
      },
      tagName: 'BUTTON'
    }
    option.props.ref(node)
    return node
  })
  let prevented = 0
  content.props.onKeyDown({
    key: 'ArrowDown',
    target: optionNodes[0],
    preventDefault: () => { prevented += 1 },
    stopPropagation() {}
  })
  tree = hooks.render(surface, 'library')
  const selected = findNodes(tree, node => node.type === 'button' && node.props.role === 'option')
  assert.equal(selected[1].props['aria-selected'], true)
  assert.equal(focusCounts.get(ID_B), 1)

  const rerenderedContent = findNode(tree, node => typeof node.props?.onKeyDown === 'function', 'rerendered keyboard handler')
  rerenderedContent.props.onKeyDown({
    key: 'Enter',
    repeat: false,
    target: optionNodes[1],
    preventDefault: () => { prevented += 1 },
    stopPropagation() {}
  })
  rerenderedContent.props.onKeyDown({
    key: 'Enter',
    repeat: true,
    target: optionNodes[1],
    preventDefault: () => { prevented += 1 },
    stopPropagation() {}
  })
  const unrelatedButton = {
    tagName: 'BUTTON',
    getAttribute: () => null,
    closest: selector => selector === 'button' ? unrelatedButton : null
  }
  rerenderedContent.props.onKeyDown({
    key: 'Enter',
    target: unrelatedButton,
    preventDefault: () => { prevented += 1 }
  })
  await flushAsync()

  assert.deepEqual(copied, ['second text'])
  assert.equal(prevented, 3)
  registered.dispose()
})

test('saving uses a synchronous guard and cannot be dismissed while pending', async () => {
  const indexedDB = new FakeIndexedDB()
  const { namespace: api, hooks, sdk } = await loadPlugin({
    crypto: { randomUUID: () => ID_A },
    indexedDB
  })
  const registered = register(api)
  const controller = registered.controllerElement
  hooks.render(controller, 'controller')
  registered.commands['prompt-pocket.open-library']()
  let surface = hooks.render(controller, 'controller')
  surface.props.onCreate()
  surface = hooks.render(controller, 'controller')
  let tree = hooks.render(surface, 'editor')
  input(tree, sdk, 'Prompt name').props.onChange({ target: { value: 'Once' } })
  textarea(tree, sdk, 'Prompt text').props.onChange({ target: { value: 'body' } })
  tree = hooks.render(surface, 'editor')
  dialog(tree, sdk).props.onOpenChange(false)
  tree = hooks.render(surface, 'editor')
  assert.equal(confirmDialog(tree, sdk).props.open, true)
  const form = findNode(tree, node => node.type === 'form', 'editor form')
  const first = form.props.onSubmit({ preventDefault() {} })
  const second = form.props.onSubmit({ preventDefault() {} })

  dialog(tree, sdk).props.onOpenChange(false)
  confirmDialog(tree, sdk).props.onConfirm()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'EditorDialog')

  await Promise.all([first, second])
  assert.equal(hooks.render(controller, 'controller').type.name, 'LibraryDialog')
  assert.equal(indexedDB.raw(DB, STORE, KEY).prompts.length, 1)
  assert.equal(indexedDB.transactionCount(DB, 'readwrite'), 1)
  registered.dispose()
})

test('import commit uses a synchronous guard and cannot be closed or discarded while pending', async () => {
  const indexedDB = new FakeIndexedDB()
  indexedDB.seed(DB, STORE, KEY, { schemaVersion: 1, prompts: [] })
  const { namespace: api, hooks, sdk } = await loadPlugin({ indexedDB })
  const registered = register(api)
  const controller = registered.controllerElement
  hooks.render(controller, 'controller')
  registered.commands['prompt-pocket.open-library']()
  let surface = hooks.render(controller, 'controller')
  surface.props.onImport()
  surface = hooks.render(controller, 'controller')
  let tree = hooks.render(surface, 'import')
  const imported = JSON.stringify({ schemaVersion: 1, prompts: [prompt(ID_A, 'Imported', 'body')] })
  textarea(tree, sdk, 'Import JSON').props.onChange({ target: { value: imported } })
  tree = hooks.render(surface, 'import')
  const previewButton = findNode(tree, node => node.type === sdk.Button && node.props.children === 'Preview', 'Preview button')
  previewButton.props.onClick()
  await flushAsync()
  tree = hooks.render(surface, 'import')
  dialog(tree, sdk).props.onOpenChange(false)
  tree = hooks.render(surface, 'import')
  assert.equal(confirmDialog(tree, sdk).props.open, true)

  const applyButton = findNode(tree, node => node.type === sdk.Button && node.props.children === 'Apply additive import', 'Apply button')
  const backButton = findNode(tree, node => node.type === sdk.Button && node.props.children === 'Back', 'Back button')
  applyButton.props.onClick()
  applyButton.props.onClick()
  dialog(tree, sdk).props.onOpenChange(false)
  backButton.props.onClick()
  confirmDialog(tree, sdk).props.onConfirm()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'ImportDialog')

  await flushAsync()
  surface = hooks.render(controller, 'controller')
  assert.equal(surface.type.name, 'LibraryDialog')
  assert.equal(indexedDB.raw(DB, STORE, KEY).prompts.length, 1)
  assert.equal(indexedDB.transactionCount(DB, 'readwrite'), 1)
  registered.dispose()
})
