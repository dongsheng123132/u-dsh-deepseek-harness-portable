import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PRODUCT_DIR = 'U-DSH'

function defaultHostRoot(env, platform) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    if (localAppData) return path.join(localAppData, PRODUCT_DIR)
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', PRODUCT_DIR)
  const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache')
  return path.join(cacheHome, 'u-dsh')
}

export function resolvePortablePaths({
  env = process.env,
  execPath = process.execPath,
  cwd = process.cwd(),
  isPackaged = false,
  platform = process.platform,
} = {}) {
  const portableOverride = env.UDSH_PORTABLE_ROOT?.trim()
  const packagedLike = isPackaged || Boolean(portableOverride)
  const portableRoot = portableOverride
    ? path.resolve(portableOverride)
    : isPackaged
      ? path.dirname(execPath)
      : path.join(cwd, '.u-dsh-dev', 'portable')
  const hostOverride = env.UDSH_HOST_ROOT?.trim()
  const hostRoot = hostOverride
    ? path.resolve(hostOverride)
    : packagedLike
      ? defaultHostRoot(env, platform)
      : path.join(cwd, '.u-dsh-dev', 'host')
  const dataDir = path.join(portableRoot, 'data')
  const stateDir = path.join(dataDir, 'u-dsh-state')
  const kernelDir = path.join(hostRoot, 'kernel')
  return {
    appRoot: portableRoot,
    portableRoot,
    dataDir,
    dshHome: path.join(dataDir, 'dsh-home'),
    stateDir,
    walletFile: path.join(stateDir, 'device-wallet.json'),
    hostRoot,
    electronDataDir: path.join(hostRoot, 'electron'),
    logsDir: path.join(hostRoot, 'logs'),
    kernelDir,
    activeKernelFile: path.join(kernelDir, 'active.json'),
  }
}

export function preparePortablePaths(paths) {
  for (const directory of [
    paths.dataDir,
    paths.dshHome,
    paths.stateDir,
    paths.hostRoot,
    paths.electronDataDir,
    paths.logsDir,
    paths.kernelDir,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  return paths
}
