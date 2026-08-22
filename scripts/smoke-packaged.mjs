/**
 * 打包产物冒烟：模拟「干净客户机」条件验证随包内核——
 * PATH 里没有 node/npm、npm registry 指向不可路由地址、虾盘云端点不可达。
 * 在这种环境下 CLI 能应答、DSH 服务能起来并给出 Web URL，
 * 才是"客户机零 npm、零下载"的决定性证据。
 */
import { once } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { startDshService } from '../src/dsh-service.js'
import { createKernelManager } from '../src/kernel-manager.js'
import { preparePortablePaths, resolvePortablePaths } from '../src/portable-paths.js'
import { loadRuntimeChannel } from '../src/runtime-channel.js'

if (process.platform !== 'win32') throw new Error('U-DSH packaged smoke currently targets Windows x64')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = process.env.PACKAGED_APP_DIR ?? path.join(root, 'dist', 'win-unpacked')
const executable = path.join(appDir, 'U-DSH Portable.exe')
const cli = path.join(appDir, 'U-DSH-CLI.cmd')
const resourcesRoot = path.join(appDir, 'resources', 'app')
const vendorRoot = path.join(appDir, 'resources')
const launcher = path.join(resourcesRoot, 'assets', 'windows-hidden-console.exe')

for (const required of [
  executable,
  cli,
  launcher,
  path.join(resourcesRoot, 'config', 'runtime-channel.json'),
  // 随包内核必须完整落包：Node 运行时 + DSH 闭包。
  path.join(vendorRoot, 'runtime', 'win32-x64', 'node.exe'),
  path.join(vendorRoot, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
]) {
  if (!existsSync(required)) throw new Error(`packaged file is missing: ${required}`)
}
if (existsSync(path.join(resourcesRoot, 'node_modules', '@deepseek-ai', 'dsh'))) {
  throw new Error('thin-shell invariant failed: packaged app contains @deepseek-ai/dsh inside app/node_modules')
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-packaged-smoke-'))
const hostRoot = process.env.UDSH_SMOKE_HOST_ROOT ?? path.join(root, '.u-dsh-dev', 'host')
const paths = preparePortablePaths(resolvePortablePaths({
  env: {
    ...process.env,
    UDSH_PORTABLE_ROOT: path.join(temporaryRoot, 'usb'),
    UDSH_HOST_ROOT: hostRoot,
  },
  platform: 'win32',
  isPackaged: true,
}))

// 干净客户机敌意环境：PATH 上没有任何 node/npm，npm registry 不可路由，
// 虾盘云端点也不可达。随包内核在这种条件下必须照常工作。
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const hostileEnv = {
  SystemRoot: systemRoot,
  windir: systemRoot,
  ComSpec: process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe'),
  PATH: [
    path.join(systemRoot, 'System32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(';'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  ProgramData: process.env.ProgramData,
  npm_config_registry: 'http://127.0.0.1:1',
  UCLAW_API_BASE_URL: 'http://127.0.0.1:9/v1',
  UCLAW_PAY_BASE_URL: 'http://127.0.0.1:9',
  UDSH_PORTABLE_ROOT: paths.portableRoot,
  UDSH_HOST_ROOT: paths.hostRoot,
}

// 先证明这个 PATH 上确实没有 node，否则"零 npm"证据不成立。
const nodeProbe = spawnSync('node', ['--version'], { env: hostileEnv, encoding: 'utf8', shell: false })
if (!nodeProbe.error) throw new Error('hostile PATH still resolves a system node; smoke evidence would be void')

try {
  const cliResult = spawnSync('cmd.exe', ['/d', '/c', cli, 'kernel.status', '--json'], {
    cwd: appDir,
    env: hostileEnv,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (cliResult.error) throw cliResult.error
  if (cliResult.status !== 0 || !cliResult.stdout.includes('pinnedVersion')) {
    throw new Error(`packaged CLI failed (${String(cliResult.status)}): ${cliResult.stderr}`)
  }
  const cliStatus = JSON.parse(cliResult.stdout)
  if (cliStatus?.result?.nodeReady !== true) {
    throw new Error(`packaged CLI reports the vendored runtime as not ready: ${cliResult.stdout}`)
  }

  const kernel = createKernelManager({ paths, channel: loadRuntimeChannel(), vendorRoot })
  const { target } = await kernel.ensure()
  process.stdout.write(`[kernel] vendored DSH ${target.version} @ ${target.entry}\n`)

  const service = startDshService({
    entry: target.entry,
    nodeExecutable: target.nodeExecutable,
    windowsLauncher: launcher,
    cwd: paths.dataDir,
    timeoutMs: 90_000,
    environment: {
      ...hostileEnv,
      NODE_OPTIONS: '',
      DSH_HOME: paths.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP: '1',
    },
  })
  try {
    const url = await service.ready
    const response = await fetch(url)
    const html = await response.text()
    if (!response.ok || !html.includes('__DSH_BOOT__')) {
      throw new Error(`official DSH Web UI smoke failed: HTTP ${response.status}`)
    }
    await kernel.activate(target.version)
    const { default: manifest } = await import(new URL('../package.json', import.meta.url), { with: { type: 'json' } })
    const artifacts = [`U-DSH-DeepSeek-Harness-Portable-${manifest.version}-Windows-x64.zip`]
      .map((name) => path.join(root, 'dist', name))
      .filter(existsSync)
    for (const artifact of artifacts) {
      process.stdout.write(`[artifact] ${path.basename(artifact)} ${(statSync(artifact).size / 1024 / 1024).toFixed(1)}MB\n`)
    }
    process.stdout.write(`PACKAGED_SMOKE_OK offline-hostile ${target.version} ${url}\n`)
  } finally {
    service.stop()
    if (service.child.exitCode === null) await once(service.child, 'exit')
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
