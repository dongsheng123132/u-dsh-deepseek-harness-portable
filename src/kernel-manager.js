import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeTextAtomic } from './atomic-file.js'
import { validateDshAt } from './harness-validate.js'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 解析随包 vendor 目录（Node 运行时 + DSH 依赖闭包所在的根）。
 * - 打包后：Electron 的 resources 目录（extraResources 把 vendor/runtime、
 *   vendor/harness 落到 resources/runtime、resources/harness）；
 *   CLI 以 ELECTRON_RUN_AS_NODE 启动时 process.resourcesPath 不可用，
 *   用 resources/app/src 相对定位兜底。
 * - 开发态：仓库里的 vendor/ 目录（先跑 npm run prepare:vendor）。
 * - UDSH_VENDOR_ROOT 供测试与冒烟脚本显式指定。
 */
export function resolveVendorRoot({
  env = process.env,
  resourcesPath = process.resourcesPath,
  moduleDir = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const override = env.UDSH_VENDOR_ROOT?.trim()
  if (override) return path.resolve(override)
  const candidates = [
    ...(resourcesPath ? [path.resolve(resourcesPath)] : []),
    path.resolve(moduleDir, '..', '..'),
    path.resolve(moduleDir, '..', 'vendor'),
  ]
  return candidates.find((candidate) => existsSync(path.join(candidate, 'harness'))) ?? candidates.at(-1)
}

/**
 * 随包内核管理器：内核（Node 运行时 + DSH 闭包）在构建时已完整 vendor 进
 * 发布包，这里只做本地解析与校验——无网络、无安装、无子进程，毫秒级。
 * 唯一允许联网的是 checkLatest（只读报告 npm 上有没有新版，且非致命）。
 */
export function createKernelManager({
  paths,
  channel,
  vendorRoot,
  fetchImpl = fetch,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!paths || !channel) throw new Error('paths 和 channel 是必填项')

  const root = vendorRoot ?? resolveVendorRoot({ env })
  const runtimeDir = path.join(root, 'runtime', `${platform}-${arch}`)
  const nodeExecutable = platform === 'win32'
    ? path.join(runtimeDir, 'node.exe')
    : path.join(runtimeDir, 'bin', 'node')
  const harnessRoot = path.join(root, 'harness')

  async function resolveDsh(version) {
    if (!EXACT_VERSION.test(version || '')) throw new Error(`DSH 版本无效：${version}`)
    if (version !== channel.dsh.version) {
      throw new Error(`随包内核只有固定版本 ${channel.dsh.version}，没有 ${version}`)
    }
    // 身份/版本/入口/peer 校验保留：便宜，且能抓到拷贝损坏或用户手删。
    return validateDshAt(harnessRoot, channel.dsh.package, version, existsSync(nodeExecutable) ? nodeExecutable : null)
  }

  async function listInstalled() {
    try {
      return [await resolveDsh(channel.dsh.version)]
    } catch {
      return []
    }
  }

  async function activeVersion() {
    try {
      const value = JSON.parse(await readFile(paths.activeKernelFile, 'utf8'))
      return EXACT_VERSION.test(value?.dshVersion || '') ? value.dshVersion : null
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }

  async function activate(version) {
    const resolved = await resolveDsh(version)
    await writeTextAtomic(paths.activeKernelFile, `${JSON.stringify({ schemaVersion: 1, dshVersion: version })}\n`)
    return resolved
  }

  /** 纯本地校验：随包运行时与闭包在不在、对不对。绝不触网。 */
  async function ensure() {
    if (platform === 'win32' && !existsSync(nodeExecutable)) {
      throw new Error(`随包 Node 运行时缺失：${nodeExecutable}。发布包不完整，请重新解压完整的发布包。`)
    }
    const previous = await activeVersion()
    const target = await resolveDsh(channel.dsh.version)
    return { target, previous }
  }

  async function registryMetadata() {
    const encodedName = encodeURIComponent(channel.dsh.package).replace('%40', '@')
    const url = `${channel.dsh.registry.replace(/\/$/, '')}/${encodedName}`
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`读取 DSH 版本目录失败：HTTP ${response.status}`)
    return response.json()
  }

  /**
   * 只读报告 npm 上有没有新版，绝不安装。必须非致命：网络不通时
   * latest 返回空串（unknown），不允许影响启动。
   */
  async function checkLatest(tag = 'latest') {
    const current = await activeVersion()
    try {
      const metadata = await registryMetadata()
      const version = metadata?.['dist-tags']?.[tag]
      return {
        current,
        pinned: channel.dsh.version,
        latest: EXACT_VERSION.test(version || '') ? version : '',
      }
    } catch {
      return { current, pinned: channel.dsh.version, latest: '' }
    }
  }

  async function status() {
    const installed = await listInstalled()
    return {
      nodeVersion: channel.node.version,
      nodeReady: existsSync(nodeExecutable),
      pinnedVersion: channel.dsh.version,
      activeVersion: await activeVersion(),
      installedVersions: installed.map(({ version }) => version),
      cacheDir: harnessRoot,
      dataDir: paths.dshHome,
    }
  }

  return {
    activate,
    activeVersion,
    checkLatest,
    ensure,
    listInstalled,
    resolveDsh,
    status,
  }
}
