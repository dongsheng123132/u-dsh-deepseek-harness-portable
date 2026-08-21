import { readTextIfExists, writeTextAtomic } from './atomic-file.js'
import { joinUrl } from './uclaw-endpoints.js'

const EMPTY_STATE = Object.freeze({
  apiKey: '',
  walletId: '',
  pendingKey: '',
  pendingKind: '',
  pendingFrom: '',
})
const PENDING_ROTATE = 'rotate'

function cleanState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    walletId: typeof source.walletId === 'string' ? source.walletId : '',
    pendingKey: typeof source.pendingKey === 'string' ? source.pendingKey : '',
    pendingKind: typeof source.pendingKind === 'string' ? source.pendingKind : '',
    pendingFrom: typeof source.pendingFrom === 'string' ? source.pendingFrom : '',
  }
}

export function createFileWalletStore(filename, logger = console) {
  return {
    async get() {
      const text = await readTextIfExists(filename)
      if (text === undefined || text.trim() === '') return { ...EMPTY_STATE }
      try {
        return cleanState(JSON.parse(text))
      } catch {
        // C6：损坏文件退化成“未绑定”，代价是可能新绑一个空钱包；UI 必须保留 adopt 入口。
        logger.warn('[device-wallet] 钱包文件损坏，本次按未绑定处理；可用“填入已有 Key”找回')
        return { ...EMPTY_STATE }
      }
    },
    async set(state) {
      await writeTextAtomic(filename, `${JSON.stringify(cleanState(state), null, 2)}\n`)
    },
  }
}

export function maskApiKey(apiKey) {
  if (!apiKey) return ''
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}…`
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-6)}`
}

function endpointCandidates(endpoints) {
  return [endpoints, ...(endpoints.fallbacks ?? [])]
}

function createHttpClient({ endpoints, fetch: fetchImpl, timeoutMs }) {
  async function request(kind, pathname, { apiKey, body, method = 'GET' } = {}) {
    let lastError = new Error('没有可用端点')
    for (const endpoint of endpointCandidates(endpoints)) {
      const base = kind === 'api' ? endpoint.apiBase : endpoint.payBase
      try {
        const response = await fetchImpl(joinUrl(base, pathname), {
          method,
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const payload = await response.json().catch(() => ({}))
        if (response.status < 500) return { response, payload, endpoint }
        lastError = new Error(`HTTP ${response.status}`)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
  return { request }
}

function validateApiKey(value) {
  const key = String(value ?? '').trim()
  if (!key) throw new Error('请先填入密钥')
  if (!key.startsWith('sk-') || key.length < 8) throw new Error('密钥应以 sk- 开头')
  if (/\s/.test(key)) throw new Error('密钥里混入了空格或换行')
  return key
}

function balancePayload(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload
}

export function createDeviceWallet({
  store,
  endpoints,
  applyKey,
  fetch: fetchImpl = fetch,
  timeoutMs = 20_000,
  logger = console,
  platform = process.platform,
} = {}) {
  if (!store) throw new Error('wallet store is required')
  if (!endpoints) throw new Error('wallet endpoints are required')
  if (typeof applyKey !== 'function') throw new Error('applyKey is required')
  const http = createHttpClient({ endpoints, fetch: fetchImpl, timeoutMs })
  let inFlight = null

  async function verifyKey(apiKey) {
    try {
      const { response } = await http.request('api', '/dashboard/billing/subscription', { apiKey })
      return response.ok
    } catch {
      return false
    }
  }

  async function finishPending(state) {
    if (!state.pendingKey) return state
    if (state.pendingKind !== PENDING_ROTATE) {
      logger.warn('[device-wallet] 未知 pendingKind，保留原状态等待人工处理')
      return state
    }
    if (!state.pendingFrom) {
      logger.warn('[device-wallet] rotate 缺少 pendingFrom，保留原状态')
      return state
    }
    if (!(await verifyKey(state.pendingKey))) return state
    const { response, payload } = await http.request('pay', '/device/rotate/commit', {
      method: 'POST',
      body: { currentKey: state.pendingFrom, newKey: state.pendingKey },
    })
    if (!response.ok) {
      logger.warn(`[device-wallet] rotate commit 失败：HTTP ${response.status}`)
      return state
    }
    const next = {
      apiKey: state.pendingKey,
      walletId: payload.walletId || state.walletId,
      pendingKey: '',
      pendingKind: '',
      pendingFrom: '',
    }
    await store.set(next)
    return next
  }

  async function bindFresh() {
    const { response, payload } = await http.request('pay', '/device/bind', {
      method: 'POST',
      // 与 ClawX 新设备分支保持同一服务端形状；U-DSH 没有旧指纹钱包要迁移。
      body: { hwHint: '', platform, channel: 'u-dsh' },
    })
    if (!response.ok || typeof payload.apiKey !== 'string') {
      throw new Error(`获取设备钱包失败：HTTP ${response.status}`)
    }
    const next = {
      apiKey: payload.apiKey,
      walletId: typeof payload.walletId === 'string' ? payload.walletId : '',
      pendingKey: '',
      pendingKind: '',
      pendingFrom: '',
    }
    await store.set(next)
    return next
  }

  async function doEnsure() {
    // C1：连打开本地存储都必须在保护内；只读 U 盘/文件锁/断网都不能挡住 DSH 启动。
    let state
    try {
      state = await store.get()
    } catch (error) {
      logger.warn('[device-wallet] 打不开钱包存储，本次不自动配置', error?.message)
      return { apiKey: '', walletId: '', configured: false }
    }
    try {
      if (state.pendingKey) state = await finishPending(state)
      if (!state.apiKey) state = await bindFresh()
      const configured = await applyKey(state.apiKey)
      return { apiKey: state.apiKey, walletId: state.walletId, configured: configured?.configured !== false }
    } catch (error) {
      logger.warn('[device-wallet] 首启收敛失败，DSH 仍继续启动', error?.message)
      return { apiKey: state.apiKey, walletId: state.walletId, configured: false }
    }
  }

  function ensure() {
    if (!inFlight) inFlight = doEnsure().finally(() => { inFlight = null })
    return inFlight
  }

  async function rotate() {
    let state = await store.get()
    if (!state.apiKey) throw new Error('当前没有设备钱包，请先联网重试')
    if (state.pendingKey && state.pendingKind !== PENDING_ROTATE) {
      throw new Error('存在未完成的钱包操作，已保留原状态')
    }
    if (!state.pendingKey) {
      const { response, payload } = await http.request('pay', '/device/rotate', {
        method: 'POST',
        body: { currentKey: state.apiKey },
      })
      if (!response.ok || typeof payload.apiKey !== 'string') {
        throw new Error(`换 Key 失败：HTTP ${response.status}`)
      }
      state = {
        ...state,
        walletId: payload.walletId || state.walletId,
        pendingKey: payload.apiKey,
        pendingKind: PENDING_ROTATE,
        pendingFrom: state.apiKey,
      }
      await store.set(state)
    }
    const settled = await finishPending(state)
    if (settled.pendingKey) throw new Error('新 Key 暂时未验证通过，旧 Key 仍有效；稍后重试即可')
    await applyKey(settled.apiKey)
    return { message: '已换成新 Key，余额保持不变', apiKeyMasked: maskApiKey(settled.apiKey) }
  }

  async function adopt(value) {
    const apiKey = validateApiKey(value)
    if (!(await verifyKey(apiKey))) throw new Error('这把 Key 用不了，没有保存')
    const current = await store.get()
    const next = {
      ...current,
      apiKey,
      walletId: '',
      pendingKey: '',
      pendingKind: '',
      pendingFrom: '',
    }
    await store.set(next)
    await applyKey(apiKey)
    return { message: '已启用这把 Key', apiKeyMasked: maskApiKey(apiKey) }
  }

  async function resetLocal() {
    let state = await store.get()
    if (state.pendingKey) {
      if (state.pendingKind !== PENDING_ROTATE) throw new Error('存在未知的未完成钱包操作，不能移除')
      state = await finishPending(state)
      if (state.pendingKey) throw new Error('换 Key 尚未完成，暂时不能移除本机钱包')
    }
    // 固定顺序：先清实际消费者，再清本地；绝不调用服务端删除钱包或余额。
    await applyKey(null)
    await store.set(EMPTY_STATE)
    const rebound = await ensure()
    return {
      message: rebound.apiKey ? '已移除旧钱包，并创建新的空钱包' : '已移除本机钱包，联网后会创建新的空钱包',
      apiKeyMasked: maskApiKey(rebound.apiKey),
    }
  }

  async function status({ refreshBalance = false } = {}) {
    const state = await store.get()
    const result = {
      available: Boolean(state.apiKey),
      apiKeyMasked: maskApiKey(state.apiKey),
      walletId: state.walletId,
      pending: Boolean(state.pendingKey),
      pendingKind: state.pendingKind,
      balance: null,
    }
    if (!refreshBalance || !state.apiKey) return result
    try {
      const { response, payload } = await http.request('pay', '/api/usage/token/', { apiKey: state.apiKey })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const usage = balancePayload(payload)
      result.balance = {
        available: Number(usage.total_available),
        used: Number(usage.total_used),
        granted: Number(usage.total_granted),
      }
    } catch (error) {
      result.balance = { error: error?.message || '余额查询失败' }
    }
    return result
  }

  async function currentApiKey() {
    return (await store.get()).apiKey
  }

  async function rechargeUrl() {
    const apiKey = await currentApiKey()
    if (!apiKey) throw new Error('当前没有设备钱包')
    return `${endpoints.payBase.replace(/\/+$/, '')}/recharge?key=${encodeURIComponent(apiKey)}`
  }

  return {
    adopt,
    currentApiKey,
    ensure,
    rechargeUrl,
    resetLocal,
    rotate,
    status,
  }
}
