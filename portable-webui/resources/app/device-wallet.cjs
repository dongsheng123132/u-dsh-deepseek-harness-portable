'use strict'
// U-DSH 便携版 · 虾盘云设备钱包（WebUI 用，纯 CJS、零外部依赖）
//
// 契约来自项目技能文档《设备钱包》（六条硬契约 C1–C6）：
//   C1 首启收敛绝不抛异常（连打开存储都要 try）——钱包只是"自动配模型"，不做门禁
//   C2 验证只用只读接口（换 Key 时验新 key，不用真实模型调用）
//   C3 pendingKind 不认识就不猜，保留现场等人工
//   C4 凭证只有一个真相源（本文件）；并发首启去重
//   C5 换 Key 后必须同步到真正用 key 的地方（DSH 的 .credentials.yaml / settings.yaml）
//   C6 存储损坏退化成"未绑定"，代价是可能新绑空钱包——所以 UI 必须保留"填入已有 Key"
//
// 存储：<便携包根>/data/u-dsh-state/device-wallet.json（跟着 U 盘走，宿主机不留凭证）

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const OVERSEA_API_BASE = 'https://api.u-claw.org/v1'
const CHINA_API_BASE = 'https://api.u-claw.org.cn/v1'
const PAY_BASE_FROM_API = (api) => api.replace(/\/+$/, '').replace(/\/v1$/i, '')
const XIAPAN_PROVIDER_ID = 'xiapan-cloud'
const XIAPAN_CREDENTIAL_REF = 'XIAPAN_CLOUD_API_KEY'
const PENDING_ROTATE = 'rotate'

const EMPTY_STATE = Object.freeze({ apiKey: '', walletId: '', pendingKey: '', pendingKind: '', pendingFrom: '' })

function log(msg) { console.log(`[U-DSH wallet] ${msg}`) }
function warn(msg) { console.warn(`[U-DSH wallet] ${msg}`) }

function cleanState(value) {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    walletId: typeof s.walletId === 'string' ? s.walletId : '',
    pendingKey: typeof s.pendingKey === 'string' ? s.pendingKey : '',
    pendingKind: typeof s.pendingKind === 'string' ? s.pendingKind : '',
    pendingFrom: typeof s.pendingFrom === 'string' ? s.pendingFrom : '',
  }
}

function maskApiKey(apiKey) {
  if (!apiKey) return ''
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}…`
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-6)}`
}

function joinUrl(base, p) { return `${base.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}` }

/** 原子写：写临时文件 → fsync → rename。exFAT 上没有 journaling，尽量别留半截文件。 */
function writeFileAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text)
    try { fs.fsyncSync(fd) } catch {}
  } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}

function createFileStore(filename) {
  return {
    get() {
      let text = ''
      try { text = fs.readFileSync(filename, 'utf8') } catch { return { ...EMPTY_STATE } }
      if (!text.trim()) return { ...EMPTY_STATE }
      try { return cleanState(JSON.parse(text)) } catch {
        // C6：损坏 → 退化成未绑定（可能新绑一个空钱包），UI 保留 adopt 入口兜底
        warn('钱包文件损坏，本次按未绑定处理；可用「填入已有 Key」找回')
        return { ...EMPTY_STATE }
      }
    },
    set(state) { writeFileAtomic(filename, `${JSON.stringify(cleanState(state), null, 2)}\n`) },
  }
}

/** 选端点：先探海外、再用国内；都探不通就用国内（后面请求会自己失败，不阻断启动）。 */
async function resolveEndpoints({ env = process.env, timeoutMs = 3000 } = {}) {
  const apiOverride = env.UCLAW_API_BASE_URL?.trim()
  const payOverride = env.UCLAW_PAY_BASE_URL?.trim()
  if (apiOverride) {
    return { apiBase: apiOverride.replace(/\/+$/, ''), payBase: (payOverride || PAY_BASE_FROM_API(apiOverride)).replace(/\/+$/, ''), fallbacks: [] }
  }
  const probe = async (base) => {
    try {
      const res = await fetch(joinUrl(base, '/models'), { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
      return res.status < 500
    } catch { return false }
  }
  if (await probe(OVERSEA_API_BASE)) {
    return { apiBase: OVERSEA_API_BASE, payBase: PAY_BASE_FROM_API(OVERSEA_API_BASE), fallbacks: [{ apiBase: CHINA_API_BASE, payBase: PAY_BASE_FROM_API(CHINA_API_BASE) }] }
  }
  return { apiBase: CHINA_API_BASE, payBase: PAY_BASE_FROM_API(CHINA_API_BASE), fallbacks: [{ apiBase: OVERSEA_API_BASE, payBase: PAY_BASE_FROM_API(OVERSEA_API_BASE) }] }
}

function createHttp({ endpoints, timeoutMs = 20000 }) {
  return async function request(kind, pathname, { apiKey, body, method = 'GET' } = {}) {
    let lastError = new Error('没有可用端点')
    for (const endpoint of [endpoints, ...(endpoints.fallbacks ?? [])]) {
      const base = kind === 'api' ? endpoint.apiBase : endpoint.payBase
      try {
        const res = await fetch(joinUrl(base, pathname), {
          method,
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const payload = await res.json().catch(() => ({}))
        if (res.status < 500) return { response: res, payload, endpoint }
        lastError = new Error(`HTTP ${res.status}`)
      } catch (error) { lastError = error }
    }
    throw lastError
  }
}

function validateApiKey(value) {
  const key = String(value ?? '').trim()
  if (!key) throw new Error('请先填入密钥')
  if (!key.startsWith('sk-') || key.length < 8) throw new Error('密钥应以 sk- 开头')
  if (/\s/.test(key)) throw new Error('密钥里混入了空格或换行')
  return key
}

/**
 * DSH 配置写入（C5：所有路径都汇到 applyKey 这一个出口）。
 * yaml 从**已安装引擎**的 node_modules 里取——启动器自带的引导 Node 只有 node 本体。
 */
function createApplyKey({ engineRoot, dshHome }) {
  function requireYaml() {
    const candidates = [
      path.join(engineRoot, 'node_modules', 'yaml'),
      path.join(engineRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml'),
    ]
    for (const candidate of candidates) {
      try { return require(candidate) } catch {}
    }
    throw new Error('引擎里找不到 yaml 模块，无法写入 DSH 配置')
  }
  function readMapping(yaml, file) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
    if (!text.trim()) return {}
    const doc = yaml.parseDocument(text, { prettyErrors: false, uniqueKeys: true })
    if (doc.errors.length > 0) throw new Error(`${path.basename(file)} 无法解析，已保留原文件`)
    const value = doc.toJS()
    if (value === null || value === undefined) return {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} 必须是 YAML mapping`)
    return value
  }
  function writeMapping(yaml, file, value) {
    writeFileAtomic(file, yaml.stringify(value, { lineWidth: 0 }))
  }

  async function discoverModels(apiBase, apiKey) {
    const res = await fetch(joinUrl(apiBase, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`获取虾盘云模型失败：HTTP ${res.status}`)
    const payload = await res.json().catch(() => ({}))
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const seen = new Set()
    const models = []
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({ id })
    }
    if (models.length === 0) throw new Error('虾盘云没有返回可用模型')
    return models
  }

  return async function applyKey(apiKey, { endpoints } = {}) {
    const yaml = requireYaml()
    fs.mkdirSync(dshHome, { recursive: true })
    const credentialsPath = path.join(dshHome, '.credentials.yaml')
    const settingsPath = path.join(dshHome, 'settings.yaml')

    const credentials = readMapping(yaml, credentialsPath)
    if (apiKey) credentials[XIAPAN_CREDENTIAL_REF] = apiKey
    else delete credentials[XIAPAN_CREDENTIAL_REF]
    writeMapping(yaml, credentialsPath, credentials)

    const settings = readMapping(yaml, settingsPath)
    if (!apiKey) {
      const llm = settings['llm-pi-ai']
      if (llm && typeof llm === 'object' && llm.providers && typeof llm.providers === 'object') {
        delete llm.providers[XIAPAN_PROVIDER_ID]
        if (Object.keys(llm.providers).length === 0) delete llm.providers
      }
      if (settings['llm-pi-ai'] && Object.keys(settings['llm-pi-ai']).length === 0) delete settings['llm-pi-ai']
      if (settings['agent-default-model']?.provider === XIAPAN_PROVIDER_ID) delete settings['agent-default-model']
      writeMapping(yaml, settingsPath, settings)
      return { configured: false, modelCount: 0 }
    }

    const llm = settings['llm-pi-ai'] && typeof settings['llm-pi-ai'] === 'object' ? settings['llm-pi-ai'] : {}
    const providers = llm.providers && typeof llm.providers === 'object' ? llm.providers : {}
    const existing = providers[XIAPAN_PROVIDER_ID]
    let models
    try {
      models = await discoverModels(endpoints.apiBase, apiKey)
    } catch (error) {
      if (Array.isArray(existing?.models) && existing.models.length > 0) models = existing.models
      else throw error
    }
    providers[XIAPAN_PROVIDER_ID] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      displayName: '虾盘云',
      apiKeyEnv: XIAPAN_CREDENTIAL_REF,
      api: 'openai-completions',
      baseURL: endpoints.apiBase,
      compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      models,
    }
    llm.providers = providers
    settings['llm-pi-ai'] = llm
    const preferred = process.env.UDSH_DEFAULT_MODEL?.trim()
    const modelId = models.some((m) => m.id === preferred) ? preferred : models[0].id
    const currentDefault = settings['agent-default-model']
    if (!currentDefault || currentDefault.provider === XIAPAN_PROVIDER_ID) {
      settings['agent-default-model'] = { provider: XIAPAN_PROVIDER_ID, model: modelId }
    }
    writeMapping(yaml, settingsPath, settings)
    return { configured: true, modelCount: models.length, model: modelId }
  }
}

/**
 * @param {{root:string, engineRoot:string, fetch?:Function}} options
 *   root = 便携包根（钱包状态写 root/data/u-dsh-state/）
 */
function createDeviceWallet({ root, engineRoot, fetch: fetchImpl } = {}) {
  if (fetchImpl) globalThis.fetch = fetchImpl
  const storeFile = path.join(root, 'data', 'u-dsh-state', 'device-wallet.json')
  const store = createFileStore(storeFile)
  const dshHome = path.join(root, 'data', 'dsh-home')
  const applyKeyRaw = createApplyKey({ engineRoot, dshHome })
  let endpointsPromise = null
  const endpoints = () => (endpointsPromise ??= resolveEndpoints())
  let inFlight = null
  let currentEndpoints = null

  async function applyKey(apiKey) {
    currentEndpoints = currentEndpoints ?? (await endpoints())
    return applyKeyRaw(apiKey, { endpoints: currentEndpoints })
  }
  const http = async (...args) => createHttp({ endpoints: currentEndpoints ?? (currentEndpoints = await endpoints()) })(...args)

  async function verifyKey(apiKey) {
    // C2：只读接口，不烧额度
    try {
      const { response } = await http('api', '/dashboard/billing/subscription', { apiKey })
      return response.ok
    } catch { return false }
  }

  async function finishPending(state) {
    if (!state.pendingKey) return state
    if (state.pendingKind !== PENDING_ROTATE) { warn('未知 pendingKind，保留原状态等待人工处理'); return state }
    if (!state.pendingFrom) { warn('rotate 缺少 pendingFrom，保留原状态'); return state }
    if (!(await verifyKey(state.pendingKey))) return state
    const { response, payload } = await http('pay', '/device/rotate/commit', {
      method: 'POST', body: { currentKey: state.pendingFrom, newKey: state.pendingKey },
    })
    if (!response.ok) { warn(`rotate commit 失败：HTTP ${response.status}`); return state }
    const next = { apiKey: state.pendingKey, walletId: payload.walletId || state.walletId, pendingKey: '', pendingKind: '', pendingFrom: '' }
    store.set(next)
    return next
  }

  async function bindFresh() {
    const { response, payload } = await http('pay', '/device/bind', {
      method: 'POST', body: { hwHint: '', platform: process.platform, channel: 'u-dsh-webui' },
    })
    if (!response.ok || typeof payload.apiKey !== 'string') throw new Error(`领取设备钱包失败：HTTP ${response.status}`)
    const next = { apiKey: payload.apiKey, walletId: typeof payload.walletId === 'string' ? payload.walletId : '', pendingKey: '', pendingKind: '', pendingFrom: '' }
    store.set(next)
    log(`已领取设备钱包：${next.walletId || '(无 id)'}`)
    return next
  }

  async function doEnsure() {
    // C1：连读存储都在保护内；断网/只读盘/文件锁都不能挡住 DSH 启动
    let state
    try { state = store.get() } catch (error) { warn(`打不开钱包存储：${error.message}`); return { apiKey: '', walletId: '', configured: false } }
    try {
      if (state.pendingKey) state = await finishPending(state)
      if (!state.apiKey) state = await bindFresh()
      const applied = await applyKey(state.apiKey)
      return { apiKey: state.apiKey, walletId: state.walletId, configured: applied?.configured !== false, model: applied?.model }
    } catch (error) {
      warn(`首启收敛失败（DSH 照常启动）：${error.message}`)
      return { apiKey: state.apiKey, walletId: state.walletId, configured: false }
    }
  }

  // C4：并发首启去重
  function ensure() { return (inFlight ??= doEnsure().finally(() => { inFlight = null })) }

  async function status({ refreshBalance = false } = {}) {
    const state = store.get()
    const result = { available: Boolean(state.apiKey), apiKey: state.apiKey, apiKeyMasked: maskApiKey(state.apiKey), walletId: state.walletId, pending: Boolean(state.pendingKey), pendingKind: state.pendingKind, balance: null, storeFile }
    if (refreshBalance && state.apiKey) {
      try {
        const { response, payload } = await http('pay', '/api/usage/token/', { apiKey: state.apiKey })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const usage = payload?.data && typeof payload.data === 'object' ? payload.data : payload
        result.balance = { available: Number(usage.total_available), used: Number(usage.total_used), granted: Number(usage.total_granted) }
      } catch (error) { result.balance = { error: error?.message || '余额查询失败' } }
    }
    return result
  }

  async function rechargeUrl() {
    const state = store.get()
    if (!state.apiKey) throw new Error('当前没有设备钱包')
    const eps = currentEndpoints ?? (currentEndpoints = await endpoints())
    return `${eps.payBase.replace(/\/+$/, '')}/recharge?key=${encodeURIComponent(state.apiKey)}`
  }

  async function rotate() {
    let state = store.get()
    if (!state.apiKey) throw new Error('当前没有设备钱包，请先联网重试')
    if (state.pendingKey && state.pendingKind !== PENDING_ROTATE) throw new Error('存在未完成的钱包操作，已保留原状态')
    if (!state.pendingKey) {
      const { response, payload } = await http('pay', '/device/rotate', { method: 'POST', body: { currentKey: state.apiKey } })
      if (!response.ok || typeof payload.apiKey !== 'string') throw new Error(`换 Key 失败：HTTP ${response.status}`)
      state = { ...state, walletId: payload.walletId || state.walletId, pendingKey: payload.apiKey, pendingKind: PENDING_ROTATE, pendingFrom: state.apiKey }
      store.set(state)
    }
    const settled = await finishPending(state)
    if (settled.pendingKey) throw new Error('新 Key 暂时未验证通过，旧 Key 仍有效；稍后重试即可')
    await applyKey(settled.apiKey)
    return { message: '已换成新 Key，余额保持不变', apiKeyMasked: maskApiKey(settled.apiKey) }
  }

  async function adopt(value) {
    const apiKey = validateApiKey(value)
    if (!(await verifyKey(apiKey))) throw new Error('这把 Key 用不了，没有保存')
    const current = store.get()
    store.set({ ...current, apiKey, walletId: '', pendingKey: '', pendingKind: '', pendingFrom: '' })
    await applyKey(apiKey)
    return { message: '已启用这把 Key', apiKeyMasked: maskApiKey(apiKey) }
  }

  async function resetLocal() {
    let state = store.get()
    if (state.pendingKey) {
      if (state.pendingKind !== PENDING_ROTATE) throw new Error('存在未知的未完成钱包操作，不能移除')
      state = await finishPending(state)
      if (state.pendingKey) throw new Error('换 Key 尚未完成，暂时不能移除本机钱包')
    }
    // 固定顺序：先清实际消费者，再清本地；绝不调用服务端删除钱包或余额
    await applyKey(null)
    store.set({ ...EMPTY_STATE })
    const rebound = await ensure()
    return { message: rebound.apiKey ? '已移除旧钱包，并创建了新的空钱包' : '已移除本机钱包，联网后会创建新的空钱包', apiKeyMasked: maskApiKey(rebound.apiKey) }
  }

  return { ensure, status, rotate, adopt, resetLocal, rechargeUrl, maskApiKey, storeFile, ensureEndpoints: endpoints }
}

module.exports = { createDeviceWallet, maskApiKey, cleanState, EMPTY_STATE, XIAPAN_PROVIDER_ID, XIAPAN_CREDENTIAL_REF }
