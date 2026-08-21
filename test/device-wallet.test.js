import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeviceWallet } from '../src/device-wallet.js'

const endpoints = {
  apiBase: 'https://api.test/v1',
  payBase: 'https://pay.test',
  fallbacks: [],
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function memoryStore(initial, events = []) {
  let value = structuredClone(initial)
  return {
    async get() { return structuredClone(value) },
    async set(next) {
      value = structuredClone(next)
      events.push({ kind: 'store', value: structuredClone(next) })
    },
    current() { return structuredClone(value) },
  }
}

test('ensure never throws when wallet storage cannot be opened', async () => {
  let applied = false
  const wallet = createDeviceWallet({
    store: { get: async () => { throw new Error('read-only drive') } },
    endpoints,
    fetch: async () => { throw new Error('must not fetch') },
    applyKey: async () => { applied = true },
    logger: { warn() {} },
  })

  assert.deepEqual(await wallet.ensure(), { apiKey: '', walletId: '', configured: false })
  assert.equal(applied, false)
})

test('concurrent ensure calls share one bind and one consumer update', async () => {
  const store = memoryStore({ apiKey: '', walletId: '', pendingKey: '', pendingKind: '', pendingFrom: '' })
  let binds = 0
  let applies = 0
  const wallet = createDeviceWallet({
    store,
    endpoints,
    fetch: async (url) => {
      assert.match(url, /\/device\/bind$/)
      binds += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return jsonResponse({ apiKey: 'sk-bound-123456', walletId: 'wallet-1' })
    },
    applyKey: async () => { applies += 1; return { configured: true } },
  })

  const first = wallet.ensure()
  const second = wallet.ensure()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(binds, 1)
  assert.equal(applies, 1)
})

test('unknown pending operations stay untouched', async () => {
  const initial = {
    apiKey: 'sk-current-123456',
    walletId: 'wallet-1',
    pendingKey: 'sk-pending-123456',
    pendingKind: 'future-operation',
    pendingFrom: 'sk-current-123456',
  }
  const store = memoryStore(initial)
  const applied = []
  const wallet = createDeviceWallet({
    store,
    endpoints,
    fetch: async () => { throw new Error('must not fetch') },
    applyKey: async (key) => { applied.push(key) },
    logger: { warn() {} },
  })

  await wallet.ensure()
  assert.deepEqual(store.current(), initial)
  assert.deepEqual(applied, ['sk-current-123456'])
  await assert.rejects(wallet.rotate(), /未完成的钱包操作/)
})

test('rotate persists pending state before verification and commit', async () => {
  const events = []
  const store = memoryStore({
    apiKey: 'sk-current-123456', walletId: 'wallet-1', pendingKey: '', pendingKind: '', pendingFrom: '',
  }, events)
  const wallet = createDeviceWallet({
    store,
    endpoints,
    fetch: async (url) => {
      if (url.endsWith('/device/rotate')) {
        events.push({ kind: 'http', step: 'rotate' })
        return jsonResponse({ apiKey: 'sk-next-123456', walletId: 'wallet-1' })
      }
      if (url.endsWith('/dashboard/billing/subscription')) {
        events.push({ kind: 'http', step: 'verify' })
        return jsonResponse({ ok: true })
      }
      if (url.endsWith('/device/rotate/commit')) {
        events.push({ kind: 'http', step: 'commit' })
        return jsonResponse({ walletId: 'wallet-1' })
      }
      throw new Error(`unexpected URL ${url}`)
    },
    applyKey: async (key) => { events.push({ kind: 'apply', key }) },
  })

  await wallet.rotate()
  assert.equal(events[1].kind, 'store')
  assert.equal(events[1].value.pendingKey, 'sk-next-123456')
  assert.deepEqual(events.slice(2, 4).map((event) => event.step), ['verify', 'commit'])
  assert.equal(store.current().apiKey, 'sk-next-123456')
  assert.equal(store.current().pendingKey, '')
  assert.equal(events.at(-1).key, 'sk-next-123456')
})

test('adopt verifies before persistence and reset clears the consumer first', async () => {
  const events = []
  const store = memoryStore({
    apiKey: 'sk-current-123456', walletId: 'wallet-1', pendingKey: '', pendingKind: '', pendingFrom: '',
  }, events)
  const requested = []
  const wallet = createDeviceWallet({
    store,
    endpoints,
    fetch: async (url) => {
      requested.push(url)
      if (url.endsWith('/dashboard/billing/subscription')) return jsonResponse({}, 401)
      if (url.endsWith('/device/bind')) return jsonResponse({ apiKey: 'sk-fresh-123456', walletId: 'wallet-2' })
      throw new Error(`unexpected URL ${url}`)
    },
    applyKey: async (key) => { events.push({ kind: 'apply', key }) },
  })

  await assert.rejects(wallet.adopt('sk-invalid-123456'), /没有保存/)
  assert.equal(store.current().apiKey, 'sk-current-123456')
  events.length = 0
  requested.length = 0

  await wallet.resetLocal()
  assert.deepEqual(events.slice(0, 2).map(({ kind }) => kind), ['apply', 'store'])
  assert.equal(events[0].key, null)
  assert.equal(requested.some((url) => url.includes('delete')), false)
  assert.equal(store.current().apiKey, 'sk-fresh-123456')
})
