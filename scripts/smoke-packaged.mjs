import { once } from 'node:events'
import { existsSync } from 'node:fs'
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
const launcher = path.join(resourcesRoot, 'assets', 'windows-hidden-console.exe')

for (const required of [executable, cli, launcher, path.join(resourcesRoot, 'config', 'runtime-channel.json')]) {
  if (!existsSync(required)) throw new Error(`packaged file is missing: ${required}`)
}
if (existsSync(path.join(resourcesRoot, 'node_modules', '@deepseek-ai', 'dsh'))) {
  throw new Error('thin-shell invariant failed: packaged app contains @deepseek-ai/dsh')
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

try {
  const cliResult = spawnSync('cmd.exe', ['/d', '/c', cli, 'kernel.status', '--json'], {
    cwd: appDir,
    env: {
      ...process.env,
      UDSH_PORTABLE_ROOT: paths.portableRoot,
      UDSH_HOST_ROOT: paths.hostRoot,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (cliResult.error) throw cliResult.error
  if (cliResult.status !== 0 || !cliResult.stdout.includes('pinnedVersion')) {
    throw new Error(`packaged CLI failed (${String(cliResult.status)}): ${cliResult.stderr}`)
  }

  const kernel = createKernelManager({ paths, channel: loadRuntimeChannel() })
  const { target } = await kernel.ensure(({ phase, received, total }) => {
    const progress = total > 0 ? ` ${Math.floor(received / total * 100)}%` : ''
    process.stdout.write(`[kernel] ${phase}${progress}\n`)
  })

  const service = startDshService({
    entry: target.entry,
    nodeExecutable: target.nodeExecutable,
    windowsLauncher: launcher,
    cwd: paths.dataDir,
    timeoutMs: 90_000,
    environment: {
      ...process.env,
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
    process.stdout.write(`PACKAGED_SMOKE_OK ${target.version} ${url}\n`)
  } finally {
    service.stop()
    if (service.child.exitCode === null) await once(service.child, 'exit')
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
