#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createCliRunner } from 'action-parity-sdk/cli'
import { buildActionRegistry } from './action-core.js'
import { createDeviceWallet, createFileWalletStore } from './device-wallet.js'
import { createDshConfigManager } from './dsh-config.js'
import { createKernelManager } from './kernel-manager.js'
import { preparePortablePaths, resolvePortablePaths } from './portable-paths.js'
import { loadRuntimeChannel } from './runtime-channel.js'
import { resolveUclawEndpoints } from './uclaw-endpoints.js'

const paths = preparePortablePaths(resolvePortablePaths())
const endpoints = await resolveUclawEndpoints()
const dshConfig = createDshConfigManager({ dshHome: paths.dshHome, endpoints })
const wallet = createDeviceWallet({
  store: createFileWalletStore(paths.walletFile),
  endpoints,
  applyKey: dshConfig.applyKey,
})
const kernel = createKernelManager({ paths, channel: loadRuntimeChannel() })

async function copyCurrentKey() {
  const apiKey = await wallet.currentApiKey()
  if (!apiKey) throw new Error('当前没有设备钱包')
  const command = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip.exe' : 'xclip'
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : []
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`写入剪贴板失败：${stderr.slice(-500)}`)))
    child.stdin.end(apiKey)
  })
}

// ActionParity：同一个动作 GUI 能做，CLI 也得能做。GUI 走 shell.openExternal，
// 这里走各平台自带的打开器。充值 URL 含 Key，只交给系统打开器，绝不进 stdout。
async function openRecharge() {
  const url = await wallet.rechargeUrl()
  const [command, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`打开充值页失败：退出码 ${code}`)))
  })
}

await createCliRunner(buildActionRegistry({ wallet, kernel, copyCurrentKey, openRecharge }), { name: 'u-dsh' }).main()
