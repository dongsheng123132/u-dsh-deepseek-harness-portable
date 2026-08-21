import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_CHANNEL_FILE = fileURLToPath(new URL('../config/runtime-channel.json', import.meta.url))

export function loadRuntimeChannel(filename = DEFAULT_CHANNEL_FILE, env = process.env) {
  const value = JSON.parse(readFileSync(filename, 'utf8'))
  if (value?.schemaVersion !== 1) throw new Error('不支持的 U-DSH 内核清单版本')
  if (!/^\d+\.\d+\.\d+$/.test(value?.node?.version || '')) throw new Error('Node 版本无效')
  if (!/^[a-f0-9]{64}$/.test(value?.node?.sha256 || '')) throw new Error('Node SHA-256 无效')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value?.dsh?.version || '')) {
    throw new Error('DSH 版本无效')
  }
  if (env.UDSH_DSH_REGISTRY?.trim()) value.dsh.registry = env.UDSH_DSH_REGISTRY.trim()
  return value
}
