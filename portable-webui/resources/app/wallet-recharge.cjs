'use strict'
// 双击「充值」时用：读出钱包 Key，直接打开虾盘云充值页。
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createDeviceWallet } = require('./device-wallet.cjs')

const appRoot = __dirname
const root = path.resolve(appRoot, '..', '..')
const envRoot = process.env.UDSH_ENGINE_HOST_ROOT?.trim()
const os = require('node:os')
const engineBase = envRoot
  ? path.resolve(envRoot)
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'U-DSH', 'engine')
    : path.join(os.homedir(), 'Library', 'Caches', 'U-DSH', 'engine')

function newestEngine() {
  try {
    const versions = require('node:fs').readdirSync(engineBase).filter((v) => !v.includes('.installing') && !v.endsWith('.lock')).sort().reverse()
    for (const v of versions) if (require('node:fs').existsSync(path.join(engineBase, v, 'node_modules', 'yaml'))) return path.join(engineBase, v)
  } catch {}
  return engineBase
}

async function main() {
  const wallet = createDeviceWallet({ root, engineRoot: newestEngine() })
  await wallet.ensure().catch(() => {})
  let url
  try {
    url = await wallet.rechargeUrl()
  } catch (error) {
    console.error(`[U-DSH 充值] ${error.message}\n先去「启动 U-DSH Web」让钱包领到 Key，再来充值。`)
    process.exitCode = 1
    return
  }
  console.log(`[U-DSH 充值] 打开充值页：${url}`)
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
  else spawn('open', [url], { stdio: 'ignore' })
}

main().catch((error) => { console.error(`[U-DSH 充值] 失败：${error.message}`); process.exit(1) })
