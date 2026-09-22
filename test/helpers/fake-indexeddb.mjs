function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function names(backing) {
  return { contains: name => backing.stores.has(name) }
}

class FakeTransaction {
  constructor(backing, storeName, mode) {
    this.backing = backing
    this.storeName = storeName
    this.mode = mode
    this.operations = []
    this.error = null
    this.aborted = false
    this.oncomplete = null
    this.onerror = null
    this.onabort = null
    this.working = null

    const run = () => this.run()
    if (mode === 'readwrite') {
      backing.writeTail = backing.writeTail.then(run, run)
    } else {
      queueMicrotask(run)
    }
  }

  objectStore(name) {
    if (name !== this.storeName) throw new Error(`Unknown store ${name}`)
    return {
      count: key => {
        const request = { result: 0, error: null, onsuccess: null, onerror: null }
        this.operations.push(async () => {
          request.result = key === undefined ? this.working.size : Number(this.working.has(key))
          request.onsuccess?.({ target: request })
        })
        return request
      },
      get: key => {
        const request = { result: undefined, error: null, onsuccess: null, onerror: null }
        this.operations.push(async () => {
          request.result = clone(this.working.get(key))
          request.onsuccess?.({ target: request })
        })
        return request
      },
      put: (value, key) => {
        const request = { result: key, error: null, onsuccess: null, onerror: null }
        this.operations.push(async () => {
          if (this.backing.failNextPut) {
            this.backing.failNextPut = false
            request.error = new Error('injected put failure')
            this.error = request.error
            request.onerror?.({ target: request })
            this.aborted = true
            return
          }
          this.working.set(key, clone(value))
          request.onsuccess?.({ target: request })
        })
        return request
      }
    }
  }

  abort() {
    this.aborted = true
  }

  async run() {
    await new Promise(resolve => queueMicrotask(resolve))
    // IndexedDB obtains a transaction's view when that transaction becomes
    // active. A queued cross-connection writer must therefore see the prior
    // writer's committed document, not a snapshot from construction time.
    this.working = this.mode === 'readwrite'
      ? new Map(this.backing.stores.get(this.storeName))
      : this.backing.stores.get(this.storeName)
    for (let index = 0; index < this.operations.length && !this.aborted; index += 1) {
      await this.operations[index]()
    }
    await new Promise(resolve => queueMicrotask(resolve))
    if (this.aborted) {
      this.onabort?.({ target: this })
      if (this.error) this.onerror?.({ target: this })
      return
    }
    if (this.mode === 'readwrite') this.backing.stores.set(this.storeName, new Map(this.working))
    this.oncomplete?.({ target: this })
  }
}

class FakeConnection {
  constructor(backing) {
    this.backing = backing
    this.objectStoreNames = names(backing)
    this.onversionchange = null
    this.closed = false
  }

  createObjectStore(name) {
    this.backing.stores.set(name, new Map())
    this.objectStoreNames = names(this.backing)
    return {}
  }

  transaction(storeName, mode) {
    if (this.closed) throw new Error('database closed')
    if (!this.backing.stores.has(storeName)) throw new Error(`Unknown store ${storeName}`)
    this.backing.transactionCounts[mode] += 1
    return new FakeTransaction(this.backing, storeName, mode)
  }

  close() {
    this.closed = true
  }
}

export class FakeIndexedDB {
  constructor() {
    this.databases = new Map()
  }

  open(name, version) {
    const request = { result: null, error: null, onupgradeneeded: null, onerror: null, onblocked: null, onsuccess: null }
    queueMicrotask(() => {
      let backing = this.databases.get(name)
      const upgrade = !backing
      if (!backing) {
        backing = { version, stores: new Map(), writeTail: Promise.resolve(), failNextPut: false, transactionCounts: { readonly: 0, readwrite: 0 } }
        this.databases.set(name, backing)
      }
      request.result = new FakeConnection(backing)
      if (upgrade) request.onupgradeneeded?.({ target: request })
      queueMicrotask(() => request.onsuccess?.({ target: request }))
    })
    return request
  }

  seed(databaseName, storeName, key, value) {
    let backing = this.databases.get(databaseName)
    if (!backing) {
      backing = { version: 1, stores: new Map(), writeTail: Promise.resolve(), failNextPut: false, transactionCounts: { readonly: 0, readwrite: 0 } }
      this.databases.set(databaseName, backing)
    }
    if (!backing.stores.has(storeName)) backing.stores.set(storeName, new Map())
    backing.stores.get(storeName).set(key, clone(value))
  }

  raw(databaseName, storeName, key) {
    return clone(this.databases.get(databaseName)?.stores.get(storeName)?.get(key))
  }

  transactionCount(databaseName, mode) {
    return this.databases.get(databaseName)?.transactionCounts[mode] ?? 0
  }

  failPut(databaseName) {
    this.databases.get(databaseName).failNextPut = true
  }
}
