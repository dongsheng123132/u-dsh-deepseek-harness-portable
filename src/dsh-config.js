import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { readTextIfExists, writeTextAtomic } from './atomic-file.js'
import { joinUrl } from './uclaw-endpoints.js'

export const XIAPAN_PROVIDER_ID = 'xiapan-cloud'
export const XIAPAN_CREDENTIAL_REF = 'XIAPAN_CLOUD_API_KEY'

function assertMapping(value, filename) {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path.basename(filename)} 必须是 YAML mapping，已保留原文件`)
  }
  return value
}

async function readYamlMapping(filename) {
  const text = await readTextIfExists(filename)
  if (text === undefined || text.trim() === '') return {}
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    // 凭据文件里有 secret，绝不把 YAML 原始报错（可能引用原文）带到日志或 UI。
    throw new Error(`${path.basename(filename)} 无法解析，已保留原文件`)
  }
  return assertMapping(document.toJS(), filename)
}

async function writeYamlMapping(filename, value) {
  await writeTextAtomic(filename, stringify(value, { lineWidth: 0 }))
}

function normalizeModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id })
  }
  return models
}

async function discoverModels(apiBase, apiKey, fetchImpl, timeoutMs) {
  const response = await fetchImpl(joinUrl(apiBase, '/models'), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`获取虾盘云模型失败：HTTP ${response.status}`)
  const models = normalizeModels(await response.json())
  if (models.length === 0) throw new Error('虾盘云没有返回可用模型')
  return models
}

function removeXiapanSettings(settings) {
  const llm = settings['llm-pi-ai']
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    const providers = llm.providers
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      delete providers[XIAPAN_PROVIDER_ID]
      if (Object.keys(providers).length === 0) delete llm.providers
    }
    if (Object.keys(llm).length === 0) delete settings['llm-pi-ai']
  }
  if (settings['agent-default-model']?.provider === XIAPAN_PROVIDER_ID) {
    delete settings['agent-default-model']
  }
}

export function createDshConfigManager({
  dshHome,
  endpoints,
  fetch: fetchImpl = fetch,
  timeoutMs = 20_000,
  env = process.env,
} = {}) {
  if (!dshHome) throw new Error('dshHome is required')
  if (!endpoints?.apiBase) throw new Error('endpoints are required')
  const credentialsPath = path.join(dshHome, '.credentials.yaml')
  const settingsPath = path.join(dshHome, 'settings.yaml')

  async function writeCredential(apiKey) {
    const credentials = await readYamlMapping(credentialsPath)
    if (apiKey) credentials[XIAPAN_CREDENTIAL_REF] = apiKey
    else delete credentials[XIAPAN_CREDENTIAL_REF]
    await writeYamlMapping(credentialsPath, credentials)
  }

  async function applyKey(apiKey) {
    await mkdir(dshHome, { recursive: true })
    if (!apiKey) {
      await writeCredential(null)
      const settings = await readYamlMapping(settingsPath)
      removeXiapanSettings(settings)
      await writeYamlMapping(settingsPath, settings)
      return { configured: false, modelCount: 0 }
    }

    // 钱包是凭证真相源；DSH 凭据文件只是实际消费者。每次启动都会从钱包收敛到这里。
    await writeCredential(apiKey)
    const settings = await readYamlMapping(settingsPath)
    const existing = settings['llm-pi-ai']?.providers?.[XIAPAN_PROVIDER_ID]
    let models
    try {
      models = await discoverModels(endpoints.apiBase, apiKey, fetchImpl, timeoutMs)
    } catch (error) {
      if (Array.isArray(existing?.models) && existing.models.length > 0) {
        models = existing.models
      } else {
        throw error
      }
    }

    const llm = settings['llm-pi-ai'] && typeof settings['llm-pi-ai'] === 'object'
      ? settings['llm-pi-ai']
      : {}
    const providers = llm.providers && typeof llm.providers === 'object'
      ? llm.providers
      : {}
    providers[XIAPAN_PROVIDER_ID] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      displayName: '虾盘云',
      apiKeyEnv: XIAPAN_CREDENTIAL_REF,
      api: 'openai-completions',
      baseURL: endpoints.apiBase,
      compat: {
        thinkingFormat: 'deepseek',
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
      },
      models,
    }
    llm.providers = providers
    settings['llm-pi-ai'] = llm

    const preferredModel = env.UDSH_DEFAULT_MODEL?.trim()
    const modelId = models.some((model) => model.id === preferredModel)
      ? preferredModel
      : models[0].id
    const currentDefault = settings['agent-default-model']
    if (!currentDefault || currentDefault.provider === XIAPAN_PROVIDER_ID) {
      settings['agent-default-model'] = {
        provider: XIAPAN_PROVIDER_ID,
        model: modelId,
      }
    }

    await writeYamlMapping(settingsPath, settings)
    return { configured: true, modelCount: models.length, model: modelId }
  }

  return {
    applyKey,
    credentialsPath,
    settingsPath,
  }
}
