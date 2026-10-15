// env-sanitize.js — 启动 DSH 内核前，剥离宿主机残留的第三方 provider 凭证环境变量。
//
// 借鉴 ClawX exFAT 交接（2026-08-22 坑 #2）与 u-claw portable/lib/strip-provider-env.mjs
// 的清单与原则：
//
//   宿主机上有 DEEPSEEK_API_KEY / OPENAI_API_KEY 之类的变量时，随包内核可能把该
//   provider 当作「已配置」，跳过首次配置引导或触发意外的安装/迁移；更糟的是把宿主机
//   主人的凭证静默带进内核，等于用别人的 key 计费、把别人机器的 key 抄进 U 盘进程。
//   U 盘是「插谁电脑用谁的」，这类宿主残留必须剥掉。
//
// 只剥第三方 provider 凭证，保留 U-DSH 自身变量（UDSH_*、UCLAW_*）与系统变量
// （LOCALAPPDATA/XDG_CACHE_HOME 等），不影响 portable-paths / dsh-config / 端点覆盖。

export const PROVIDER_ENV_VARS = Object.freeze([
  // —— u-claw strip-provider-env.mjs 清单（同步自 ClawX buildGatewayRuntimeEnv）——
  'AI_GATEWAY_API_KEY',
  'ARCEEAI_API_KEY',
  'BASETEN_API_KEY',
  'BYTEPLUS_API_KEY',
  'CEREBRAS_API_KEY',
  'CHUTES_API_KEY',
  'CHUTES_OAUTH_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'COMFY_API_KEY',
  'COMFY_CLOUD_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEATHERLESS_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'KIMICODE_API_KEY',
  'LONGCAT_API_KEY',
  'MISTRAL_API_KEY',
  'MODEL_API_KEY',
  'MODELSTUDIO_API_KEY',
  'MOONSHOT_API_KEY',
  'NOVITA_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'STEPFUN_API_KEY',
  'SYNTHETIC_API_KEY',
  'TOKENHUB_API_KEY',
  'TOKENPLAN_API_KEY',
  'VENICE_API_KEY',
  'VOLCANO_ENGINE_API_KEY',
  'VOYAGE_API_KEY',
  'VYDRA_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  // —— 常见通用 provider 凭证（Harness 内核可能认的）——
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'HUGGING_FACE_HUB_TOKEN',
  'HF_TOKEN',
])

/**
 * 返回净化后的运行环境与被剥离的变量名。
 * 幂等：对已净化或未污染的 env 调用不会改变任何值。
 */
export function sanitizeRuntimeEnv(env = process.env) {
  const next = { ...env }
  const stripped = []
  for (const name of PROVIDER_ENV_VARS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      delete next[name]
      stripped.push(name)
    }
  }
  return { env: next, stripped }
}
