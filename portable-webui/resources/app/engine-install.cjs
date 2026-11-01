'use strict'
// U-DSH 引擎安装器：把「大块头」（Node 运行时 + DSH 依赖闭包）装到本机硬盘，
// 数据（DSH_HOME）永远留在 U 盘的 data/。
//
// 设计目标（用户要的「大块头放本地硬盘，数据放 U 盘，来回切换」）：
//   - 默认 auto：U 盘（容量小）→ 引擎装本机，换电脑首次自动装一次，之后本机高速启动；
//                移动硬盘（容量大，速度够）→ 引擎装盘上，保持自包含。
//   - 显式 host / drive / temp / usb 可覆盖：
//       host  = 装本机（%LOCALAPPDATA% / Library/Caches）
//       drive = 装盘上（<盘根>/engine/<版本>）
//       temp  = 拷到系统临时目录，退出尽力清理（对安装敏感的客户）
//       usb   = 不安装，直接从 U 盘跑（最慢，零残留）
//
// 版本按 DSH 包版本隔离；升级 = 新目录，旧的不动，可回退。
const {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  cpSync, statSync, statfsSync, readdirSync, lstatSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PRODUCT = 'U-DSH'
const MANIFEST = 'engine-manifest.json'
const MODES = new Set(['auto', 'host', 'drive', 'temp', 'usb'])

function log(msg) { console.log('[U-DSH engine] ' + msg) }
function warn(msg) { console.warn('[U-DSH engine] ' + msg) }

function nodeRel(platform, arch) {
  if (platform === 'win32') return path.join('runtime', 'node-win-x64', 'node.exe')
  return path.join('runtime', arch === 'arm64' ? 'node-mac-arm64' : 'node-mac-x64', 'bin', 'node')
}
function entryRel() { return path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') }

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/** 读 appRoot 里随包的引擎版本（以 vendored DSH 包的 version 为准）。 */
function readEngineVersion(appRoot) {
  const pkg = readJson(path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (!pkg || !pkg.version) throw new Error('随包引擎不完整：缺 node_modules/@deepseek-ai/dsh/package.json')
  return pkg.version
}

function hostEngineBase() {
  const override = process.env.UDSH_ENGINE_HOST_ROOT?.trim()
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(local, PRODUCT, 'engine')
  }
  return path.join(os.homedir(), 'Library', 'Caches', PRODUCT, 'engine')
}

function driveTotalBytes(p) {
  try {
    const s = statfsSync(p)
    return Number(s.bsize || 0) * Number(s.blocks || 0)
  } catch { return 0 }
}

/** 选安装位置：显式 mode 优先；auto 时按「盘容量」判断是不是移动硬盘。 */
function pickMode(appRoot, requested) {
  if (requested && MODES.has(requested) && requested !== 'auto') return requested
  const thresholdGB = Number(process.env.UDSH_HDD_THRESHOLD_GB ?? 128)
  const root = path.resolve(appRoot, '..', '..')
  const total = driveTotalBytes(root)
  if (thresholdGB > 0 && total >= thresholdGB * 1024 ** 3) return 'drive'
  return 'host'
}

function targetRootFor(mode, appRoot, version) {
  const root = path.resolve(appRoot, '..', '..')
  if (mode === 'drive') return path.join(root, 'engine', version)
  if (mode === 'temp') return path.join(os.tmpdir(), `u-dsh-engine-${version}-${process.pid}`)
  return path.join(hostEngineBase(), version)
}

function manifestMatches(dir, version, rel) {
  const m = readJson(path.join(dir, MANIFEST))
  if (!m || m.version !== version) return false
  return existsSync(path.join(dir, rel.node)) && existsSync(path.join(dir, rel.entry))
}

/** 把 appRoot 里的 runtime + node_modules + package.json 原子装到 target。 */
function installEngine(appRoot, target, version, rel) {
  mkdirSync(path.dirname(target), { recursive: true })
  const staging = target + '.installing-' + process.pid
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const started = Date.now()
  for (const name of ['runtime', 'node_modules']) {
    const from = path.join(appRoot, name)
    if (!existsSync(from)) throw new Error(`随包引擎缺 ${name}/，无法安装`)
    log(`安装 ${name}/ → ${target}`)
    cpSync(from, path.join(staging, name), { recursive: true, dereference: true })
  }
  const pkgFrom = path.join(appRoot, 'package.json')
  if (existsSync(pkgFrom)) cpSync(pkgFrom, path.join(staging, 'package.json'))
  writeFileSync(path.join(staging, MANIFEST), JSON.stringify({
    schemaVersion: 1, version, installedAt: new Date().toISOString(), product: PRODUCT,
  }, null, 2) + '\n')
  // 原子落地：先删旧目录再 rename（同盘 rename 是原子的）。
  rmSync(target, { recursive: true, force: true })
  try { renameSync(staging, target) } catch (e) {
    // 跨设备（如 temp 在别的卷）rename 会 EXDEV，退化成 copy。
    cpSync(staging, target, { recursive: true, dereference: true })
    rmSync(staging, { recursive: true, force: true })
  }
  log(`安装完成：${target}（${((Date.now() - started) / 1000).toFixed(1)}s）`)
}

function registerTempCleanup(target) {
  let cleaned = false
  const cleanup = () => { if (cleaned) return; cleaned = true; try { rmSync(target, { recursive: true, force: true }) } catch {} }
  process.once('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { cleanup(); process.exit(0) })
  }
}

/**
 * 解析引擎位置；必要时把引擎装到本机/盘上/临时目录。
 * @returns {{mode:string, engineRoot:string, nodeExe:string, entry:string, dataRoot:string}}
 */
function resolveEngine({ appRoot, mode, platform = process.platform, arch = process.arch } = {}) {
  appRoot = appRoot || __dirname
  const root = path.resolve(appRoot, '..', '..')
  const version = readEngineVersion(appRoot)
  const rel = { node: nodeRel(platform, arch), entry: entryRel() }
  const chosen = pickMode(appRoot, mode || process.env.UDSH_ENGINE_MODE)
  if (chosen === 'usb') {
    return { mode: chosen, engineRoot: appRoot, nodeExe: path.join(appRoot, rel.node), entry: path.join(appRoot, rel.entry), dataRoot: path.join(root, 'data', 'dsh-home') }
  }
  const target = targetRootFor(chosen, appRoot, version)
  if (manifestMatches(target, version, rel)) {
    log(`复用已安装引擎（${chosen}）：${target}`)
  } else {
    installEngine(appRoot, target, version, rel)
  }
  if (chosen === 'temp') registerTempCleanup(target)
  return { mode: chosen, engineRoot: target, nodeExe: path.join(target, rel.node), entry: path.join(target, rel.entry), dataRoot: path.join(root, 'data', 'dsh-home') }
}

module.exports = { resolveEngine, pickMode, hostEngineBase, nodeRel, entryRel, MANIFEST }
