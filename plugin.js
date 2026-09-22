import {
  Button,
  Codicon,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  KEYBINDS_AREA,
  PALETTE_AREA,
  SearchField,
  Textarea,
  Tip,
  TITLEBAR_AREAS,
  host
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

export const DATABASE_NAME = 'prompt-pocket'
export const DATABASE_VERSION = 1
export const DOCUMENT_STORE = 'documents'
export const DOCUMENT_KEY = 'library'
export const SCHEMA_VERSION = 1

const DOCUMENT_FIELDS = ['prompts', 'schemaVersion']
const PROMPT_FIELDS = ['createdAt', 'id', 'name', 'text', 'updatedAt']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class PromptPocketError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PromptPocketError'
    this.code = code
  }
}

export class StaleEditError extends PromptPocketError {
  constructor(message = 'This prompt changed in another window. Reopen it and try again.') {
    super('stale-edit', message)
    this.name = 'StaleEditError'
  }
}

function fail(code, message, options) {
  throw new PromptPocketError(code, message, options)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireExactFields(value, fields, path) {
  const actual = Object.keys(value).sort()
  if (actual.length !== fields.length || fields.some((field, index) => actual[index] !== field)) {
    fail('validation', `${path} must contain exactly: ${fields.join(', ')}`)
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

export function validatePrompt(value, path = 'prompt') {
  if (!isObject(value)) fail('validation', `${path} must be an object`)
  requireExactFields(value, PROMPT_FIELDS, path)
  if (typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)) {
    fail('validation', `${path}.id must be a UUID`)
  }
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.trim() !== value.name) {
    fail('validation', `${path}.name must be nonblank and have no surrounding whitespace`)
  }
  if (typeof value.text !== 'string' || value.text.trim().length === 0) {
    fail('validation', `${path}.text must contain non-whitespace text`)
  }
  if (!isCanonicalTimestamp(value.createdAt)) {
    fail('validation', `${path}.createdAt must be a canonical UTC timestamp`)
  }
  if (!isCanonicalTimestamp(value.updatedAt)) {
    fail('validation', `${path}.updatedAt must be a canonical UTC timestamp`)
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    fail('validation', `${path}.updatedAt must not precede createdAt`)
  }
  return {
    id: value.id,
    name: value.name,
    text: value.text,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

export function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, prompts: [] }
}

export function validateDocument(value, path = 'document') {
  if (!isObject(value)) fail('malformed-storage', `${path} must be an object`)
  requireExactFields(value, DOCUMENT_FIELDS, path)
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported-schema', `${path}.schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (!Array.isArray(value.prompts)) fail('malformed-storage', `${path}.prompts must be an array`)

  const ids = new Set()
  const prompts = value.prompts.map((prompt, index) => {
    let validated
    try {
      validated = validatePrompt(prompt, `${path}.prompts[${index}]`)
    } catch (error) {
      if (error instanceof PromptPocketError && error.code === 'validation') {
        throw new PromptPocketError('malformed-storage', error.message, { cause: error })
      }
      throw error
    }
    if (ids.has(validated.id)) {
      fail('malformed-storage', `${path}.prompts contains duplicate id ${validated.id}`)
    }
    ids.add(validated.id)
    return validated
  })
  return { schemaVersion: SCHEMA_VERSION, prompts }
}

export function parseImport(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    fail('invalid-import', `Import is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`, {
      cause: error
    })
  }
  try {
    return validateDocument(value, 'import')
  } catch (error) {
    if (error instanceof PromptPocketError) {
      throw new PromptPocketError('invalid-import', error.message, { cause: error })
    }
    throw error
  }
}

export function serializeDocument(document) {
  return `${JSON.stringify(validateDocument(document), null, 2)}\n`
}

export function promptEquals(left, right) {
  return PROMPT_FIELDS.every(field => left?.[field] === right?.[field])
}

export function documentEquals(left, right) {
  if (!left || !right || left.schemaVersion !== right.schemaVersion || left.prompts.length !== right.prompts.length) {
    return false
  }
  return left.prompts.every((prompt, index) => promptEquals(prompt, right.prompts[index]))
}

export function searchPrompts(document, query) {
  const needle = query.toLowerCase()
  return validateDocument(document).prompts
    .filter(prompt => needle.length === 0 || prompt.name.toLowerCase().includes(needle) || prompt.text.toLowerCase().includes(needle))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

function uniqueUuid(usedIds, makeUuid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = makeUuid()
    if (typeof id === 'string' && UUID_PATTERN.test(id) && !usedIds.has(id)) return id
  }
  fail('uuid', 'Could not generate a unique UUID')
}

export function planImport(currentValue, incomingValue, makeUuid = defaultUuid) {
  const current = validateDocument(currentValue, 'current library')
  const incoming = validateDocument(incomingValue, 'import')
  const existingById = new Map(current.prompts.map(prompt => [prompt.id, prompt]))
  const usedIds = new Set([...existingById.keys(), ...incoming.prompts.map(prompt => prompt.id)])
  const additions = []
  let skipped = 0
  let collisionCopies = 0

  for (const incomingPrompt of incoming.prompts) {
    const existing = existingById.get(incomingPrompt.id)
    if (!existing) {
      additions.push(incomingPrompt)
    } else if (promptEquals(existing, incomingPrompt)) {
      skipped += 1
    } else {
      const id = uniqueUuid(usedIds, makeUuid)
      usedIds.add(id)
      additions.push({ ...incomingPrompt, id })
      collisionCopies += 1
    }
  }

  const document = validateDocument({ schemaVersion: SCHEMA_VERSION, prompts: [...current.prompts, ...additions] })
  return { document, additions: additions.length, skipped, collisionCopies }
}

export function defaultUuid() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('uuid', 'Secure UUID generation is unavailable in this browser')
  }
  return globalThis.crypto.randomUUID()
}

function transactionFailure(transaction, fallback) {
  const detail = transaction?.error?.message
  return new PromptPocketError('storage-failure', detail ? `${fallback}: ${detail}` : fallback, {
    cause: transaction?.error ?? undefined
  })
}

export class IndexedDbDocumentStore {
  constructor(indexedDb = globalThis.indexedDB) {
    this.indexedDb = indexedDb
    this.database = null
    this.opening = null
    this.disposed = false
  }

  async open() {
    if (this.disposed) fail('storage-closed', 'Prompt Pocket storage is closed')
    if (!this.indexedDb || typeof this.indexedDb.open !== 'function') {
      fail('storage-unsupported', 'IndexedDB is unavailable; Prompt Pocket is read-only and cannot save data')
    }
    if (this.database) return this.database
    if (this.opening) return this.opening

    this.opening = new Promise((resolve, reject) => {
      let settled = false
      const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(DOCUMENT_STORE)) database.createObjectStore(DOCUMENT_STORE)
      }
      request.onerror = () => {
        settled = true
        reject(new PromptPocketError('storage-failure', `Could not open Prompt Pocket storage: ${request.error?.message ?? 'unknown error'}`, { cause: request.error ?? undefined }))
      }
      request.onblocked = () => {
        settled = true
        reject(new PromptPocketError('storage-blocked', 'Prompt Pocket storage upgrade is blocked by another window'))
      }
      request.onsuccess = () => {
        const database = request.result
        if (settled || this.disposed) {
          database.close()
          if (this.disposed && !settled) reject(new PromptPocketError('storage-closed', 'Prompt Pocket storage is closed'))
          return
        }
        if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
          database.close()
          reject(new PromptPocketError('malformed-storage', 'Prompt Pocket database is missing its document store'))
          return
        }
        database.onversionchange = () => {
          database.close()
          if (this.database === database) this.database = null
        }
        this.database = database
        resolve(database)
      }
    }).finally(() => {
      this.opening = null
    })
    return this.opening
  }

  async read() {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      let raw
      let present = false
      let requestError = null
      let transaction
      try {
        transaction = database.transaction(DOCUMENT_STORE, 'readonly')
        const store = transaction.objectStore(DOCUMENT_STORE)
        const count = store.count(DOCUMENT_KEY)
        count.onsuccess = () => {
          present = count.result > 0
          if (!present) return
          const request = store.get(DOCUMENT_KEY)
          request.onsuccess = () => {
            raw = request.result
          }
          request.onerror = () => {
            requestError = request.error
          }
        }
        count.onerror = () => {
          requestError = count.error
        }
      } catch (error) {
        reject(new PromptPocketError('storage-failure', 'Could not start a Prompt Pocket read', { cause: error }))
        return
      }
      transaction.oncomplete = () => {
        try {
          resolve(present ? validateDocument(raw, 'stored library') : emptyDocument())
        } catch (error) {
          reject(error)
        }
      }
      transaction.onerror = () => reject(new PromptPocketError('storage-failure', `Could not read Prompt Pocket storage: ${requestError?.message ?? transaction.error?.message ?? 'unknown error'}`, { cause: requestError ?? transaction.error ?? undefined }))
      transaction.onabort = () => reject(transactionFailure(transaction, 'Prompt Pocket read was aborted'))
    })
  }

  async mutate(mutator) {
    if (typeof mutator !== 'function') fail('storage-failure', 'Storage mutation must be a function')
    const database = await this.open()
    return new Promise((resolve, reject) => {
      let nextDocument
      let heldError = null
      let transaction
      try {
        transaction = database.transaction(DOCUMENT_STORE, 'readwrite')
        const store = transaction.objectStore(DOCUMENT_STORE)
        const mutateCurrent = raw => {
          try {
            const current = raw.present ? validateDocument(raw.value, 'stored library') : emptyDocument()
            const candidate = mutator(current)
            if (candidate && typeof candidate.then === 'function') fail('storage-failure', 'IndexedDB mutations must be synchronous')
            nextDocument = validateDocument(candidate, 'next library')
            const put = store.put(nextDocument, DOCUMENT_KEY)
            put.onerror = () => {
              heldError = new PromptPocketError('storage-failure', `Could not write Prompt Pocket storage: ${put.error?.message ?? 'unknown error'}`, { cause: put.error ?? undefined })
            }
          } catch (error) {
            heldError = error
            try {
              transaction.abort()
            } catch {
              // The transaction may already have aborted; onabort still reports the held error.
            }
          }
        }
        const count = store.count(DOCUMENT_KEY)
        count.onerror = () => {
          heldError = new PromptPocketError('storage-failure', `Could not check storage before writing: ${count.error?.message ?? 'unknown error'}`, { cause: count.error ?? undefined })
        }
        count.onsuccess = () => {
          if (count.result === 0) {
            mutateCurrent({ present: false })
            return
          }
          const request = store.get(DOCUMENT_KEY)
          request.onerror = () => {
            heldError = new PromptPocketError('storage-failure', `Could not read before writing: ${request.error?.message ?? 'unknown error'}`, { cause: request.error ?? undefined })
          }
          request.onsuccess = () => mutateCurrent({ present: true, value: request.result })
        }
      } catch (error) {
        reject(new PromptPocketError('storage-failure', 'Could not start a Prompt Pocket write', { cause: error }))
        return
      }
      transaction.oncomplete = () => resolve(nextDocument)
      transaction.onerror = () => reject(heldError ?? transactionFailure(transaction, 'Prompt Pocket write failed'))
      transaction.onabort = () => reject(heldError ?? transactionFailure(transaction, 'Prompt Pocket write was aborted'))
    })
  }

  close() {
    this.disposed = true
    this.database?.close()
    this.database = null
  }
}

function editorValues(name, text) {
  if (typeof name !== 'string' || name.trim().length === 0) fail('validation', 'Name is required')
  if (typeof text !== 'string' || text.trim().length === 0) fail('validation', 'Prompt text is required')
  return { name: name.trim(), text }
}

export class PromptRepository {
  constructor(store, { makeUuid = defaultUuid, now = () => new Date().toISOString(), onChanged = () => {} } = {}) {
    this.store = store
    this.makeUuid = makeUuid
    this.now = now
    this.onChanged = onChanged
  }

  read() {
    return this.store.read()
  }

  async create(name, text) {
    const values = editorValues(name, text)
    const timestamp = this.now()
    const prompt = validatePrompt({ id: this.makeUuid(), ...values, createdAt: timestamp, updatedAt: timestamp })
    const document = await this.store.mutate(current => ({ ...current, prompts: [...current.prompts, prompt] }))
    this.onChanged()
    return { document, prompt }
  }

  async update(expectedPrompt, name, text) {
    const expected = validatePrompt(expectedPrompt, 'expected prompt')
    const values = editorValues(name, text)
    let saved
    const document = await this.store.mutate(current => {
      const index = current.prompts.findIndex(prompt => prompt.id === expected.id)
      if (index < 0 || !promptEquals(current.prompts[index], expected)) throw new StaleEditError()
      const unchanged = expected.name === values.name && expected.text === values.text
      saved = unchanged ? expected : validatePrompt({ ...expected, ...values, updatedAt: this.now() })
      const prompts = current.prompts.slice()
      prompts[index] = saved
      return { ...current, prompts }
    })
    this.onChanged()
    return { document, prompt: saved }
  }

  async delete(expectedPrompt) {
    const expected = validatePrompt(expectedPrompt, 'expected prompt')
    const document = await this.store.mutate(current => {
      const index = current.prompts.findIndex(prompt => prompt.id === expected.id)
      if (index < 0 || !promptEquals(current.prompts[index], expected)) throw new StaleEditError('This prompt changed or was deleted in another window. Reopen the library and try again.')
      return { ...current, prompts: current.prompts.filter((_, promptIndex) => promptIndex !== index) }
    })
    this.onChanged()
    return document
  }

  async previewImport(text) {
    const incoming = parseImport(text)
    const current = await this.read()
    const plan = planImport(current, incoming, this.makeUuid)
    return { incoming, current, ...plan }
  }

  async applyImport(incomingValue, expectedCurrent) {
    const incoming = validateDocument(incomingValue, 'import')
    const expected = validateDocument(expectedCurrent, 'import preview base')
    let summary
    const document = await this.store.mutate(current => {
      if (!documentEquals(current, expected)) throw new StaleEditError('The library changed after the import preview. Preview the import again.')
      summary = planImport(current, incoming, this.makeUuid)
      return summary.document
    })
    this.onChanged()
    return { document, additions: summary.additions, skipped: summary.skipped, collisionCopies: summary.collisionCopies }
  }
}

function readableError(error) {
  return error instanceof Error ? error.message : 'An unknown error occurred'
}

function createRuntime(ctx, dependencies = {}) {
  const listeners = new Set()
  const store = new IndexedDbDocumentStore(dependencies.indexedDB ?? globalThis.indexedDB)
  let channel = null
  const announce = () => {
    for (const listener of listeners) listener()
    try {
      channel?.postMessage({ type: 'changed' })
    } catch {
      // BroadcastChannel is an optional refresh hint; IndexedDB remains authoritative.
    }
  }
  const repository = new PromptRepository(store, { onChanged: announce })
  if (typeof globalThis.BroadcastChannel === 'function') {
    try {
      channel = new globalThis.BroadcastChannel('prompt-pocket:changes')
      channel.onmessage = event => {
        if (event?.data?.type === 'changed') for (const listener of listeners) listener()
      }
    } catch {
      channel = null
    }
  }
  return {
    ctx,
    repository,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      listeners.clear()
      channel?.close()
      channel = null
      store.close()
    }
  }
}

let activeRuntime = null
let pendingIntent = null
const intentListeners = new Set()

function openSurface(kind, payload = null) {
  pendingIntent = { kind, payload, token: `${Date.now()}:${Math.random()}` }
  for (const listener of intentListeners) listener(pendingIntent)
}

function notify(kind, message) {
  host.notify({ kind, message })
}

function FieldError({ message }) {
  return message ? jsx('div', { className: 'text-xs text-destructive', role: 'alert', children: message }) : null
}

function EditorDialog({ record, onClose, onReturn }) {
  const editing = Boolean(record)
  const initialName = record?.name ?? ''
  const initialText = record?.text ?? ''
  const [name, setName] = useState(initialName)
  const [text, setText] = useState(initialText)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const nameRef = useRef(null)
  const savingRef = useRef(false)
  const dirty = name !== initialName || text !== initialText

  const requestClose = () => {
    if (savingRef.current) return
    if (dirty) setDiscardOpen(true)
    else onClose()
  }
  const save = async event => {
    event?.preventDefault?.()
    if (savingRef.current) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      if (editing) await activeRuntime.repository.update(record, name, text)
      else await activeRuntime.repository.create(name, text)
      notify('success', editing ? 'Prompt updated' : 'Prompt saved')
      onReturn()
    } catch (saveError) {
      setError(readableError(saveError))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return jsxs(Fragment, {
    children: [
      jsx(Dialog, {
        open: true,
        onOpenChange: value => !value && requestClose(),
        children: jsxs(DialogContent, {
          className: 'w-[min(42rem,94vw)] max-w-none',
          onOpenAutoFocus: event => {
            event.preventDefault()
            nameRef.current?.focus()
          },
          children: [
            jsxs(DialogHeader, {
              children: [
                jsx(DialogTitle, { children: editing ? 'Edit prompt' : 'Save prompt' }),
                jsx(DialogDescription, {
                  children: editing
                    ? 'Edit the saved copy. The composer is never changed.'
                    : 'Paste the prompt manually below. Saving does not read, send, clear, or change the composer.'
                })
              ]
            }),
            jsxs('form', {
              className: 'grid gap-3',
              onSubmit: save,
              children: [
                jsxs('label', {
                  className: 'grid gap-1 text-xs font-medium',
                  children: [
                    'Name',
                    jsx(Input, {
                      'aria-label': 'Prompt name',
                      disabled: saving,
                      onChange: event => setName(event.target.value),
                      ref: nameRef,
                      value: name
                    })
                  ]
                }),
                jsxs('label', {
                  className: 'grid gap-1 text-xs font-medium',
                  children: [
                    'Prompt text',
                    jsx(Textarea, {
                      'aria-label': 'Prompt text',
                      className: 'min-h-56 resize-y whitespace-pre-wrap font-mono',
                      disabled: saving,
                      onChange: event => setText(event.target.value),
                      value: text
                    })
                  ]
                }),
                jsx(FieldError, { message: error }),
                jsxs(DialogFooter, {
                  children: [
                    jsx(Button, { disabled: saving, onClick: requestClose, type: 'button', variant: 'ghost', children: 'Cancel' }),
                    jsx(Button, { disabled: saving, type: 'submit', children: saving ? 'Saving…' : 'Save' })
                  ]
                })
              ]
            })
          ]
        })
      }),
      jsx(ConfirmDialog, {
        open: discardOpen,
        onClose: () => {
          if (!savingRef.current) setDiscardOpen(false)
        },
        onConfirm: () => {
          if (!savingRef.current) onClose()
        },
        title: 'Discard unsaved changes?',
        description: 'Your edits have not been saved.',
        confirmLabel: 'Discard',
        destructive: true,
        dismissOnConfirm: true
      })
    ]
  })
}

function ManualCopy({ label, text, onDismiss }) {
  const textRef = useRef(null)
  const select = () => {
    textRef.current?.focus()
    textRef.current?.select()
  }
  return jsxs('div', {
    className: 'grid gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3',
    children: [
      jsx('div', { className: 'text-xs font-medium', children: `${label} Clipboard access is unavailable; select and copy this text manually.` }),
      jsx(Textarea, {
        'aria-label': `${label} manual copy text`,
        className: 'max-h-48 min-h-24 resize-y whitespace-pre font-mono',
        onFocus: event => event.currentTarget.select(),
        readOnly: true,
        ref: textRef,
        value: text
      }),
      jsxs('div', {
        className: 'flex justify-end gap-2',
        children: [
          jsx(Button, { onClick: onDismiss, size: 'sm', type: 'button', variant: 'ghost', children: 'Hide' }),
          jsx(Button, { onClick: select, size: 'sm', type: 'button', children: 'Select text' })
        ]
      })
    ]
  })
}

function LibraryDialog({ onClose, onCreate, onEdit, onImport }) {
  const [document, setDocument] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [manualCopy, setManualCopy] = useState(null)
  const deletePendingRef = useRef(null)
  const optionRefs = useRef(new Map())
  const searchRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await activeRuntime.repository.read()
      setDocument(next)
      setError(null)
    } catch (loadError) {
      setDocument(null)
      setError(readableError(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return activeRuntime.subscribe(() => void load())
  }, [load])

  const results = useMemo(() => (document ? searchPrompts(document, query) : []), [document, query])
  const selected = results.find(prompt => prompt.id === selectedId) ?? results[0] ?? null
  useEffect(() => {
    if (!loading && !error && document?.prompts.length > 0) searchRef.current?.focus()
  }, [document, error, loading])
  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id ?? null)
  }, [selected?.id, selectedId])

  const copyText = async (label, text) => {
    let copied = false
    try {
      copied = await activeRuntime.ctx.os.writeClipboard(text)
    } catch {
      copied = false
    }
    if (copied) {
      setManualCopy(null)
      notify('success', `${label} copied. Paste it manually where you want to use it.`)
    } else {
      setManualCopy({ label, text })
    }
  }

  const onKeyDown = event => {
    const target = event.target
    if (target?.tagName === 'TEXTAREA') return
    const option = target?.closest?.('[role="option"]') ?? (target?.getAttribute?.('role') === 'option' ? target : null)
    const button = target?.closest?.('button') ?? (target?.tagName === 'BUTTON' ? target : null)
    if (button && !option) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation?.()
      if (results.length === 0) return
      const focusedId = option?.dataset?.promptId
      const currentIndex = Math.max(0, results.findIndex(prompt => prompt.id === (focusedId ?? selected?.id)))
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = Math.min(results.length - 1, Math.max(0, currentIndex + delta))
      const next = results[nextIndex]
      setSelectedId(next.id)
      optionRefs.current.get(next.id)?.focus()
    } else if (event.key === 'Enter') {
      const focusedId = option?.dataset?.promptId
      const active = (focusedId ? results.find(prompt => prompt.id === focusedId) : null) ?? selected
      if (!active) return
      event.preventDefault()
      event.stopPropagation?.()
      if (event.repeat) return
      setSelectedId(active.id)
      void copyText('Prompt', active.text)
    }
  }

  const leaveLibrary = action => {
    if (!deletePendingRef.current) action()
  }

  const deleteSelected = () => {
    // Share the pending result even before React/SDK busy state rerenders.
    // An early resolved duplicate would let ConfirmDialog close mid-commit.
    if (deletePendingRef.current) return deletePendingRef.current
    deletePendingRef.current = (async () => {
      try {
        await activeRuntime.repository.delete(deleting)
        notify('success', 'Prompt deleted')
        await load()
      } finally {
        deletePendingRef.current = null
      }
    })()
    return deletePendingRef.current
  }

  let body
  if (loading) {
    body = jsx('div', { className: 'grid min-h-64 place-items-center text-sm text-(--ui-text-secondary)', children: 'Loading prompts…' })
  } else if (error) {
    body = jsx(ErrorState, {
      title: 'Prompt library unavailable',
      description: error,
      children: jsx(Button, { onClick: () => void load(), type: 'button', variant: 'secondary', children: 'Try again' })
    })
  } else if (document.prompts.length === 0) {
    body = jsx(EmptyState, { title: 'No saved prompts', description: 'Create one, then paste its text manually into the editor.' })
  } else {
    body = jsxs('div', {
      className: 'grid min-h-0 grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1.2fr)] gap-3',
      children: [
        jsxs('div', {
          className: 'grid min-h-0 grid-rows-[auto_1fr] gap-2',
          children: [
            jsx(SearchField, {
              'aria-label': 'Search saved prompts',
              containerClassName: 'w-full',
              inputClassName: 'w-full',
              inputRef: searchRef,
              onChange: setQuery,
              placeholder: 'Search prompts',
              value: query
            }),
            results.length === 0
              ? jsx(EmptyState, { className: 'min-h-48', title: 'No matches', description: 'Try a different name or phrase.' })
              : jsx('div', {
                  'aria-label': 'Saved prompts',
                  className: 'max-h-[48vh] overflow-y-auto rounded-lg border border-(--ui-stroke-secondary) p-1',
                  role: 'listbox',
                  children: results.map(prompt =>
                    jsxs('button', {
                      'aria-selected': prompt.id === selected?.id,
                      className: `grid w-full gap-0.5 rounded-md px-2 py-2 text-left ${prompt.id === selected?.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`,
                      onClick: () => setSelectedId(prompt.id),
                      onDoubleClick: () => void copyText('Prompt', prompt.text),
                      'data-prompt-id': prompt.id,
                      ref: element => {
                        if (element) optionRefs.current.set(prompt.id, element)
                        else optionRefs.current.delete(prompt.id)
                      },
                      role: 'option',
                      type: 'button',
                      children: [
                        jsx('span', { className: 'truncate text-sm font-medium', children: prompt.name }),
                        jsx('span', { className: 'truncate text-xs text-(--ui-text-tertiary)', children: new Date(prompt.updatedAt).toLocaleString() })
                      ]
                    },
                    prompt.id)
                  )
                })
          ]
        }),
        selected
          ? jsxs('section', {
              'aria-label': 'Prompt preview',
              className: 'grid min-h-0 grid-rows-[auto_1fr_auto] gap-2',
              children: [
                jsxs('div', {
                  children: [
                    jsx('h3', { className: 'truncate text-sm font-semibold', children: selected.name }),
                    jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: `Updated ${new Date(selected.updatedAt).toLocaleString()}` })
                  ]
                }),
                jsx('pre', {
                  className: 'max-h-[48vh] min-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-(--ui-stroke-secondary) p-3 font-mono text-xs',
                  children: selected.text
                }),
                jsxs('div', {
                  className: 'flex flex-wrap justify-end gap-2',
                  children: [
                    jsx(Button, { onClick: () => leaveLibrary(() => setDeleting(selected)), size: 'sm', type: 'button', variant: 'destructive', children: 'Delete' }),
                    jsx(Button, { onClick: () => leaveLibrary(() => onEdit(selected)), size: 'sm', type: 'button', variant: 'secondary', children: 'Edit' }),
                    jsx(Button, {
                      onClick: () => void copyText('Prompt', selected.text),
                      size: 'sm',
                      type: 'button',
                      children: 'Copy prompt'
                    })
                  ]
                })
              ]
            })
          : null
      ]
    })
  }

  return jsxs(Fragment, {
    children: [
      jsx(Dialog, {
        open: true,
        onOpenChange: value => !value && leaveLibrary(onClose),
        children: jsxs(DialogContent, {
          className: 'w-[min(58rem,96vw)] max-w-none',
          onKeyDown,
          onOpenAutoFocus: event => {
            event.preventDefault()
            searchRef.current?.focus()
          },
          children: [
            jsxs(DialogHeader, {
              children: [
                jsx(DialogTitle, { children: 'Prompt Pocket' }),
                jsx(DialogDescription, { children: 'Find a saved prompt, copy its exact text, then paste it manually into the composer.' })
              ]
            }),
            jsxs('div', {
              className: 'flex flex-wrap gap-2',
              children: [
                jsx(Button, { onClick: () => leaveLibrary(onCreate), size: 'sm', type: 'button', variant: 'secondary', children: 'New prompt' }),
                jsx(Button, { disabled: !document || Boolean(error), onClick: () => leaveLibrary(onImport), size: 'sm', type: 'button', variant: 'secondary', children: 'Import JSON' }),
                jsx(Button, {
                  disabled: !document || Boolean(error),
                  onClick: () => void copyText('Export JSON', serializeDocument(document)),
                  size: 'sm',
                  type: 'button',
                  variant: 'secondary',
                  children: 'Copy export JSON'
                })
              ]
            }),
            body,
            manualCopy ? jsx(ManualCopy, { ...manualCopy, onDismiss: () => setManualCopy(null) }) : null,
            jsx(DialogFooter, { children: jsx(Button, { onClick: () => leaveLibrary(onClose), type: 'button', variant: 'ghost', children: 'Close' }) })
          ]
        })
      }),
      jsx(ConfirmDialog, {
        open: Boolean(deleting),
        onClose: () => leaveLibrary(() => setDeleting(null)),
        onConfirm: deleteSelected,
        title: deleting ? `Delete “${deleting.name}”?` : 'Delete prompt?',
        description: 'This removes only this saved prompt. This action cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
        dismissOnConfirm: false
      })
    ]
  })
}

function ImportDialog({ onClose, onApplied, onBack }) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discardAction, setDiscardAction] = useState(null)
  const busyRef = useRef(false)
  const textRef = useRef(null)

  const requestExit = action => {
    if (busyRef.current) return
    if (text.length > 0) {
      setDiscardAction(() => action)
      setDiscardOpen(true)
    } else {
      action()
    }
  }
  const makePreview = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      setPreview(await activeRuntime.repository.previewImport(text))
    } catch (previewError) {
      setPreview(null)
      setError(readableError(previewError))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!preview || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await activeRuntime.repository.applyImport(preview.incoming, preview.current)
      notify('success', `Imported ${result.additions} prompt${result.additions === 1 ? '' : 's'}`)
      onApplied()
    } catch (applyError) {
      setError(readableError(applyError))
      setPreview(null)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return jsxs(Fragment, {
    children: [
      jsx(Dialog, {
        open: true,
        onOpenChange: value => !value && requestExit(onClose),
        children: jsxs(DialogContent, {
          className: 'w-[min(44rem,94vw)] max-w-none',
          onOpenAutoFocus: event => {
            event.preventDefault()
            textRef.current?.focus()
          },
          children: [
            jsxs(DialogHeader, {
              children: [
                jsx(DialogTitle, { children: 'Import Prompt Pocket JSON' }),
                jsx(DialogDescription, { children: 'Paste a complete v1 export. Validation is all-or-nothing; import only adds records.' })
              ]
            }),
            jsx(Textarea, {
              'aria-label': 'Import JSON',
              className: 'min-h-64 resize-y whitespace-pre font-mono',
              disabled: busy,
              onChange: event => {
                setText(event.target.value)
                setPreview(null)
                setError(null)
              },
              ref: textRef,
              value: text
            }),
            preview
              ? jsxs('div', {
                  className: 'rounded-lg border border-(--ui-stroke-secondary) p-3 text-sm',
                  role: 'status',
                  children: [
                    jsx('div', { className: 'font-medium', children: 'Import preview' }),
                    jsx('div', { children: `${preview.additions} additions · ${preview.skipped} identical skipped · ${preview.collisionCopies} ID collision copies` })
                  ]
                })
              : null,
            jsx(FieldError, { message: error }),
            jsxs(DialogFooter, {
              children: [
                jsx(Button, { disabled: busy, onClick: () => requestExit(onBack), type: 'button', variant: 'ghost', children: 'Back' }),
                jsx(Button, { disabled: busy || text.length === 0, onClick: () => void makePreview(), type: 'button', variant: 'secondary', children: busy ? 'Checking…' : 'Preview' }),
                jsx(Button, { disabled: busy || !preview, onClick: () => void apply(), type: 'button', children: busy ? 'Importing…' : 'Apply additive import' })
              ]
            })
          ]
        })
      }),
      jsx(ConfirmDialog, {
        open: discardOpen,
        onClose: () => {
          if (busyRef.current) return
          setDiscardOpen(false)
          setDiscardAction(null)
        },
        onConfirm: () => {
          if (!busyRef.current) discardAction?.()
        },
        title: 'Discard pasted import?',
        description: 'Nothing has been imported yet.',
        confirmLabel: 'Discard',
        destructive: true,
        dismissOnConfirm: true
      })
    ]
  })
}

function PromptPocketController() {
  const [surface, setSurface] = useState(null)
  const surfaceRef = useRef(null)
  const showSurface = next => {
    pendingIntent = null
    surfaceRef.current = next
    setSurface(next)
  }
  useEffect(() => {
    const listener = intent => {
      if (surfaceRef.current) {
        if (pendingIntent?.token === intent.token) pendingIntent = null
        return
      }
      let next = null
      if (intent.kind === 'library') next = { kind: 'library', token: intent.token }
      if (pendingIntent?.token === intent.token) pendingIntent = null
      if (next) {
        surfaceRef.current = next
        setSurface(next)
      }
    }
    intentListeners.add(listener)
    if (pendingIntent) listener(pendingIntent)
    return () => intentListeners.delete(listener)
  }, [])

  if (!surface) return null
  if (surface.kind === 'editor') {
    return jsx(EditorDialog, {
      key: surface.token,
      record: surface.record,
      onClose: () => showSurface(null),
      onReturn: () => showSurface({ kind: 'library', token: `${Date.now()}:return` })
    })
  }
  if (surface.kind === 'import') {
    return jsx(ImportDialog, {
      key: surface.token,
      onApplied: () => showSurface({ kind: 'library', token: `${Date.now()}:imported` }),
      onBack: () => showSurface({ kind: 'library', token: `${Date.now()}:back` }),
      onClose: () => showSurface(null)
    })
  }
  return jsx(LibraryDialog, {
    key: surface.token,
    onClose: () => showSurface(null),
    onCreate: () => showSurface({ kind: 'editor', record: null, token: `${Date.now()}:new` }),
    onEdit: record => showSurface({ kind: 'editor', record, token: `${Date.now()}:edit` }),
    onImport: () => showSurface({ kind: 'import', token: `${Date.now()}:import` })
  })
}

function LibraryTool() {
  return jsx(Tip, {
    label: 'Prompt pocket',
    placement: 'toolbar',
    children: jsx(Button, {
      'aria-label': 'Prompt pocket',
      className: 'text-muted-foreground/85 hover:bg-(--ui-control-hover-background) hover:text-foreground bg-transparent select-none',
      onClick: () => openSurface('library'),
      onPointerDown: event => event.stopPropagation(),
      size: 'icon-titlebar',
      type: 'button',
      variant: 'ghost',
      children: jsx(Codicon, { name: 'library', size: '0.875rem' })
    })
  })
}

export const plugin = {
  id: 'prompt-pocket',
  name: 'Prompt Pocket',
  description: 'Save, search, and manually copy reusable prompts.',
  defaultEnabled: false,
  register(ctx) {
    activeRuntime?.close()
    const runtime = createRuntime(ctx)
    activeRuntime = runtime
    const openLibrary = () => openSurface('library')

    ctx.registerMany([
      {
        id: 'library-tool',
        area: TITLEBAR_AREAS.right,
        order: 80,
        render: () => jsx(LibraryTool, {})
      },
      {
        id: 'dialog-controller',
        area: TITLEBAR_AREAS.center,
        order: 900,
        render: () => jsx(PromptPocketController, {})
      },
      {
        id: 'open-library-palette',
        area: PALETTE_AREA,
        data: {
          id: 'prompt-pocket.open-library',
          action: 'prompt-pocket.open-library',
          label: 'Prompt Pocket: Open library',
          keywords: ['prompt', 'copy', 'library'],
          run: openLibrary
        }
      },
      {
        id: 'open-library-keybind',
        area: KEYBINDS_AREA,
        data: {
          id: 'prompt-pocket.open-library',
          label: 'Open prompt library',
          category: 'view',
          defaults: [],
          run: openLibrary
        }
      }
    ])

    ctx.onDispose(() => {
      runtime.close()
      if (activeRuntime === runtime) {
        activeRuntime = null
        pendingIntent = null
        intentListeners.clear()
      }
    })
  }
}

export default plugin
