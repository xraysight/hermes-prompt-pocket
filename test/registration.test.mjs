import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

test('registers an icon-only titlebar library tool with tooltip, no composer UI, and unbound actions without sends', async () => {
  const { namespace: api, calls, hooks, sdk } = await loadPlugin()
  const contributions = []
  const disposers = []
  let storageTouches = 0
  let restCalls = 0
  let socketCalls = 0
  const ctx = {
    registerMany(items) {
      contributions.push(...items)
      return () => undefined
    },
    onDispose(dispose) {
      disposers.push(dispose)
    },
    os: { writeClipboard: async () => false },
    get storage() {
      storageTouches += 1
      throw new Error('ctx.storage must not be accessed')
    },
    rest() {
      restCalls += 1
    },
    socket() {
      socketCalls += 1
    }
  }

  api.default.register(ctx)
  assert.equal(api.default.id, 'prompt-pocket')
  assert.equal(contributions.some(item => item.area?.startsWith('composer.')), false)
  assert.equal(contributions.some(item => item.area === 'titleBar.center' && typeof item.render === 'function'), true)

  const palette = contributions.filter(item => item.area === 'palette').map(item => item.data)
  const keybinds = contributions.filter(item => item.area === 'keybinds').map(item => item.data)
  assert.deepEqual(Array.from(palette, item => item.id), ['prompt-pocket.open-library'])
  assert.deepEqual(Array.from(keybinds, item => item.id), ['prompt-pocket.open-library'])
  const tools = contributions.filter(item => item.area === 'titleBar.right')
  assert.equal(tools.length, 1)
  const tree = hooks.render(tools[0].render(), 'titlebar')
  assert.equal(tree.type, sdk.Tip)
  assert.equal(tree.props.label, 'Prompt pocket')
  assert.equal(tree.props.placement, 'toolbar')
  const button = tree.props.children
  assert.equal(button.type, sdk.Button)
  assert.equal(button.props['aria-label'], 'Prompt pocket')
  assert.equal(button.props.size, 'icon-titlebar')
  assert.equal(button.props.children.type, sdk.Codicon)
  assert.equal(button.props.children.props.name, 'library')
  const controller = contributions.find(item => item.id === 'dialog-controller').render()
  hooks.render(controller, 'controller')
  button.props.onClick()
  assert.equal(hooks.render(controller, 'controller').type.name, 'LibraryDialog')
  assert.equal(keybinds.every(item => Array.isArray(item.defaults) && item.defaults.length === 0), true)
  assert.equal(palette.every(item => keybinds.some(keybind => keybind.id === item.action)), true)

  for (const command of [...palette, ...keybinds]) command.run()
  assert.equal(storageTouches, 0)
  assert.equal(restCalls, 0)
  assert.equal(socketCalls, 0)
  assert.equal(calls.requests.length, 0)
  assert.equal(disposers.length, 1)
  disposers[0]()
})
