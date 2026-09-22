import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createConfirmDialog } from './confirm-dialog.mjs'

const SDK_EXPORTS = [
  'Button',
  'Codicon',
  'ConfirmDialog',
  'Dialog',
  'DialogContent',
  'DialogDescription',
  'DialogFooter',
  'DialogHeader',
  'DialogTitle',
  'EmptyState',
  'ErrorState',
  'Input',
  'KEYBINDS_AREA',
  'PALETTE_AREA',
  'SearchField',
  'Textarea',
  'Tip',
  'TITLEBAR_AREAS',
  'host'
]

function component(name) {
  const fixture = () => null
  fixture.displayName = name
  return fixture
}

function sameDependencies(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function createHookFixture() {
  const instances = new Map()
  let current = null

  const nextHook = () => {
    if (!current) throw new Error('Hook called outside fixture render')
    return current.cursor++
  }
  const react = {
    useCallback(value, dependencies) {
      return react.useMemo(() => value, dependencies)
    },
    useEffect(effect, dependencies) {
      const index = nextHook()
      const previous = current.hooks[index]
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        current.pendingEffects.push({ dependencies, effect, index })
      }
    },
    useMemo(factory, dependencies) {
      const index = nextHook()
      const previous = current.hooks[index]
      if (previous && sameDependencies(previous.dependencies, dependencies)) return previous.value
      const value = factory()
      current.hooks[index] = { dependencies, value }
      return value
    },
    useRef(value) {
      const index = nextHook()
      if (!current.hooks[index]) current.hooks[index] = { current: value }
      return current.hooks[index]
    },
    useState(initialValue) {
      const instance = current
      const index = nextHook()
      if (!instance.hooks[index]) {
        const state = { value: typeof initialValue === 'function' ? initialValue() : initialValue }
        state.set = value => {
          state.value = typeof value === 'function' ? value(state.value) : value
        }
        instance.hooks[index] = state
      }
      const state = instance.hooks[index]
      return [state.value, state.set]
    }
  }

  return {
    react,
    render(element, key = 'root') {
      if (!element || typeof element.type !== 'function') throw new Error('Hook fixture requires a component element')
      let instance = instances.get(key)
      if (!instance) {
        instance = { cursor: 0, hooks: [], pendingEffects: [] }
        instances.set(key, instance)
      }
      instance.cursor = 0
      instance.pendingEffects = []
      const previous = current
      current = instance
      let output
      try {
        output = element.type(element.props ?? {})
      } finally {
        current = previous
      }
      for (const pending of instance.pendingEffects) {
        const prior = instance.hooks[pending.index]
        prior?.cleanup?.()
        const cleanup = pending.effect()
        instance.hooks[pending.index] = { cleanup, dependencies: pending.dependencies }
      }
      return output
    },
    unmount(key = 'root') {
      const instance = instances.get(key)
      if (!instance) return
      for (const hook of instance.hooks) hook?.cleanup?.()
      instances.delete(key)
    }
  }
}

export async function loadPlugin({ crypto, indexedDB } = {}) {
  const calls = { notifications: [], requests: [] }
  const sdk = {
    Button: component('Button'),
    Codicon: component('Codicon'),
    ConfirmDialog: component('ConfirmDialog'),
    Dialog: component('Dialog'),
    DialogContent: component('DialogContent'),
    DialogDescription: component('DialogDescription'),
    DialogFooter: component('DialogFooter'),
    DialogHeader: component('DialogHeader'),
    DialogTitle: component('DialogTitle'),
    EmptyState: component('EmptyState'),
    ErrorState: component('ErrorState'),
    Input: component('Input'),
    KEYBINDS_AREA: 'keybinds',
    PALETTE_AREA: 'palette',
    SearchField: component('SearchField'),
    Textarea: component('Textarea'),
    Tip: component('Tip'),
    TITLEBAR_AREAS: { center: 'titleBar.center', right: 'titleBar.right' },
    host: {
      notify(value) {
        calls.notifications.push(value)
      },
      request(...args) {
        calls.requests.push(args)
        throw new Error('host.request must not be called')
      }
    }
  }
  const hooks = createHookFixture()
  const react = hooks.react
  const jsxRuntime = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key })
  }
  sdk.ConfirmDialog = createConfirmDialog(react, sdk, jsxRuntime.jsx)
  const context = vm.createContext({
    console,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Promise,
    Set,
    ...(crypto === undefined ? {} : { crypto }),
    ...(indexedDB === undefined ? {} : { indexedDB }),
    clearTimeout,
    setTimeout
  })
  const source = await readFile(new URL('../../plugin.js', import.meta.url), 'utf8')
  const module = new vm.SourceTextModule(source, { context, identifier: 'plugin.js' })

  const fixtures = new Map([
    ['@hermes/plugin-sdk', new vm.SyntheticModule(SDK_EXPORTS, function loadSdk() {
      for (const name of SDK_EXPORTS) this.setExport(name, sdk[name])
    }, { context })],
    ['react', new vm.SyntheticModule(Object.keys(react), function loadReact() {
      for (const [name, value] of Object.entries(react)) this.setExport(name, value)
    }, { context })],
    ['react/jsx-runtime', new vm.SyntheticModule(Object.keys(jsxRuntime), function loadJsx() {
      for (const [name, value] of Object.entries(jsxRuntime)) this.setExport(name, value)
    }, { context })]
  ])

  await module.link(specifier => {
    const fixture = fixtures.get(specifier)
    if (!fixture) throw new Error(`Unexpected import: ${specifier}`)
    return fixture
  })
  await module.evaluate()
  return { namespace: module.namespace, calls, hooks, sdk }
}
