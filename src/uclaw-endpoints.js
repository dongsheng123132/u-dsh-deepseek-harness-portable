const OVERSEA_API_BASE = 'https://api.u-claw.org/v1'
const OVERSEA_PAY_BASE = 'https://api.u-claw.org'
const CHINA_API_BASE = 'https://api.u-claw.org.cn/v1'
const CHINA_PAY_BASE = 'https://api.u-claw.org.cn'

function joinUrl(base, pathname) {
  return `${base.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`
}

function payBaseFromApi(apiBase) {
  return apiBase.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

async function reachable(apiBase, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(joinUrl(apiBase, '/models'), {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.status < 500
  } catch {
    return false
  }
}

export async function resolveUclawEndpoints({
  env = process.env,
  fetch: fetchImpl = fetch,
  probeTimeoutMs = 3_000,
} = {}) {
  const apiOverride = env.UCLAW_API_BASE_URL?.trim()
  const payOverride = env.UCLAW_PAY_BASE_URL?.trim()
  if (apiOverride) {
    return {
      apiBase: apiOverride.replace(/\/+$/, ''),
      payBase: (payOverride || payBaseFromApi(apiOverride)).replace(/\/+$/, ''),
      fallbacks: [],
    }
  }

  if (await reachable(OVERSEA_API_BASE, fetchImpl, probeTimeoutMs)) {
    return {
      apiBase: OVERSEA_API_BASE,
      payBase: OVERSEA_PAY_BASE,
      fallbacks: [{ apiBase: CHINA_API_BASE, payBase: CHINA_PAY_BASE }],
    }
  }
  return {
    apiBase: CHINA_API_BASE,
    payBase: CHINA_PAY_BASE,
    fallbacks: [{ apiBase: OVERSEA_API_BASE, payBase: OVERSEA_PAY_BASE }],
  }
}

export { joinUrl }
