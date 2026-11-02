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
//
// 两种随包形态都支持：
//   engine.tar（推荐）—— 整个引擎（runtime/ + node_modules/ + package.json）打成**一个**归档文件。
//     U 盘上只躺 1 个大文件：exFAT 常见 128KB 簇 + 一万多个小文件会让包在盘上膨胀到 1.4GB、
//     首次拷贝几十分钟（实测）；单文件归档后拷贝是顺序读写，首次安装只在本机解包。
//   松散目录（兼容旧发布包）—— runtime/ + node_modules/ 平铺在 appRoot 里。
const {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync,
  cpSync, statSync, statfsSync, readdirSync, lstatSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')

const PRODUCT = 'U-DSH'
const MANIFEST = 'engine-manifest.json'
const ENGINE_TAR = 'engine.tar'
const ENGINE_TAR_GZ = 'engine.tar.gz'
const ENGINE_JSON = 'engine.json'
const MODES = new Set(['auto', 'host', 'drive', 'temp', 'usb'])

function log(msg) { console.log('[U-DSH engine] ' + msg) }
function warn(msg) { console.warn('[U-DSH engine] ' + msg) }

function nodeRel(platform, arch) {
  if (platform === 'win32') return path.join('runtime', 'node-win-x64', 'node.exe')
  return path.join('runtime', arch === 'arm64' ? 'node-mac-arm64' : 'node-mac-x64', 'bin', 'node')
}
function entryRel() { return path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') }

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/**
 * 读 appRoot 里随包的引擎版本。
 * 单文件归档形态下 node_modules 在归档里面，读不到，所以打包时会在旁边写一份
 * engine.json（{version, engine, nodeRel, entry}）；松散目录形态仍回退到读包。
 */
function readEngineVersion(appRoot) {
  const meta = readJson(path.join(appRoot, ENGINE_JSON))
  if (meta && meta.version) return meta.version
  const pkg = readJson(path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (!pkg || !pkg.version) throw new Error('随包引擎不完整：缺 engine.json 或 node_modules/@deepseek-ai/dsh/package.json')
  return pkg.version
}

/** 流式计算归档的 SHA-256（U 盘/传输损坏是我们实测遇到过的问题）。 */
function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = require('node:fs').openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    for (;;) {
      const n = require('node:fs').readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally { require('node:fs').closeSync(fd) }
  return hash.digest('hex')
}

/** 解包前先确认目标盘放得下（归档解压后约 450MB），不然客户会看到一堆 EIO/ENOSPC。 */
function ensureFreeSpace(dir, needBytes) {
  try {
    const s = statfsSync(dir)
    const free = Number(s.bavail ?? s.bfree ?? 0) * Number(s.bsize ?? 0)
    if (free > 0 && free < needBytes) {
      throw new Error(`本机磁盘空间不够：${dir} 只剩 ${(free / 1024 ** 2).toFixed(0)} MB，安装引擎需要约 ${(needBytes / 1024 ** 2).toFixed(0)} MB`)
    }
  } catch (error) {
    if (error.message.startsWith('本机磁盘空间不够')) throw error
    /* statfs 不可用就算了，不阻断 */
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 极端环境不支持就空转 */ }
}

/**
 * 同一台机器同时双击两次 / 插两支盘时的互斥。
 * 锁就是一个同名目录：抢到的人装，没抢到的人等；等的时候一旦发现已经装好就直接复用。
 * 锁目录 mtime 超过 10 分钟视为僵死（进程被杀/断电留下的），清掉重试。
 */
function withInstallLock(target, isReady, install) {
  const lock = target + '.lock'
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      mkdirSync(lock, { recursive: true })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (isReady()) { log('别的进程已经装好了，直接复用'); return }
      if (Date.now() > deadline) {
        warn('等别的安装超过 3 分钟，清掉锁强行继续')
        try { rmSync(lock, { recursive: true, force: true }) } catch {}
        continue
      }
      sleepSync(300)
    }
  }
  try {
    return install()
  } finally {
    try { rmSync(lock, { recursive: true, force: true }) } catch {}
  }
}

/** 找到随包的引擎归档（.tar.gz 优先，其次 .tar）。 */
function findTar(appRoot) {
  for (const name of [ENGINE_TAR_GZ, ENGINE_TAR]) {
    const candidate = path.join(appRoot, name)
    if (existsSync(candidate)) return { path: candidate, name, gzip: name.endsWith('.gz') }
  }
  return null
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
  // 默认一律装到本机缓存（%LOCALAPPDATA% / ~/Library/Caches）：
  // 产品承诺是「引擎装本机、数据留盘」，不能按盘容量猜——实测 477GB 的本地盘会被
  // 旧逻辑判成 drive（引擎塞进便携包），256GB 的 U 盘同理，等于把 500MB 又写回盘上。
  // 只有本机缓存不可写时，才回退到 drive（引擎放便携包内）。
  if (process.env.UDSH_FORCE_DRIVE_ENGINE === '1') return 'drive'
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

/**
 * 扫掉上一次跑崩/被强杀留下的临时引擎。
 * Windows 上 SIGTERM 是不可捕获的强杀，`process.on('exit')` 根本不会跑，
 * 所以「退出即清理」在 Windows 只能靠**下次启动补扫**兜底。
 */
function sweepStaleTempEngines(maxAgeMs = 2 * 60 * 60 * 1000) {
  const tmp = os.tmpdir()
  let entries = []
  try { entries = readdirSync(tmp) } catch { return }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith('u-dsh-engine-')) continue
    const full = path.join(tmp, name)
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue
      rmSync(full, { recursive: true, force: true })
      log(`清理上次遗留的临时引擎：${full}`)
    } catch { /* 正被别的进程用着，下次再说 */ }
  }
}

function registerTempCleanup(target) {
  let cleaned = false
  const cleanup = () => { if (cleaned) return; cleaned = true; try { rmSync(target, { recursive: true, force: true }) } catch {} }
  process.once('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { cleanup(); process.exit(0) })
  }
}

function hasTar(appRoot) { return findTar(appRoot) !== null }
function hasLoosePayload(appRoot) {
  return existsSync(path.join(appRoot, 'runtime')) && existsSync(path.join(appRoot, 'node_modules'))
}

/** 用系统 tar 把随包引擎归档解到 staging，再原子落地。 */
function extractEngineTar(appRoot, target, version, rel) {
  const found = findTar(appRoot)
  if (!found) throw new Error(`随包里找不到引擎归档（${ENGINE_TAR_GZ} / ${ENGINE_TAR}）`)
  const archive = found.path
  mkdirSync(path.dirname(target), { recursive: true })

  // 先校验归档完整性：U 盘掉数据/拷贝中断是真实发生过的，坏包必须当场说清楚，
  // 不能解到一半才报奇怪的错。
  const meta = readJson(path.join(appRoot, ENGINE_JSON))
  if (meta?.sha256) {
    const started = Date.now()
    log('校验引擎归档完整性（SHA-256）…')
    const actual = sha256File(archive)
    if (actual !== meta.sha256) {
      throw new Error(`随包引擎归档已损坏（U 盘掉数据或拷贝不完整）：${found.name}\n  期望 ${meta.sha256}\n  实际 ${actual}\n  请把 U 盘上的 u-dsh 目录重新完整拷贝一遍`)
    }
    log(`完整性校验通过（${((Date.now() - started) / 1000).toFixed(1)}s）`)
  }
  ensureFreeSpace(path.dirname(target), 700 * 1024 ** 2)
  const staging = target + '.installing-' + process.pid
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const started = Date.now()
  log(`解包 ${found.name}（${(statSync(archive).size / 1024 ** 2).toFixed(1)} MB）→ ${target}`)
  // Windows 10 1803+ / macOS / Linux 都自带 bsdtar 或 GNU tar（两者都认 -xzf）。
  execFileSync('tar', [found.gzip ? '-xzf' : '-xf', archive, '-C', staging], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  // 归档里可以只放闭包（省掉 U 盘上再存一份 Node 的 110MB）；
  // 缺 Node 运行时就把随包（盘上）那份拷进来——只有一个大文件，拷得很快。
  if (!existsSync(path.join(staging, rel.node)) && existsSync(path.join(appRoot, 'runtime'))) {
    log('把随包 Node 运行时拷进引擎目录')
    cpSync(path.join(appRoot, 'runtime'), path.join(staging, 'runtime'), { recursive: true, dereference: true })
  }
  if (!existsSync(path.join(staging, rel.node)) || !existsSync(path.join(staging, rel.entry))) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`随包 ${found.name} 解出来不完整：缺 Node 运行时或 DSH 入口`)
  }
  writeFileSync(path.join(staging, MANIFEST), JSON.stringify({
    schemaVersion: 1, version, installedAt: new Date().toISOString(), product: PRODUCT, source: found.name,
  }, null, 2) + '\n')
  rmSync(target, { recursive: true, force: true })
  try { renameSync(staging, target) } catch {
    cpSync(staging, target, { recursive: true, dereference: true })
    rmSync(staging, { recursive: true, force: true })
  }
  log(`解包完成：${target}（${((Date.now() - started) / 1000).toFixed(1)}s）`)
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
  sweepStaleTempEngines()
  let chosen = pickMode(appRoot, mode || process.env.UDSH_ENGINE_MODE)
  // usb = 不安装直接跑。单文件归档形态没法「直接跑」，退化成 temp（装到临时目录、退出清理），
  // 仍然做到「不落地本机」。
  if (chosen === 'usb' && !hasLoosePayload(appRoot)) {
    warn('usb 模式需要松散目录形态；本包是 engine.tar，改成 temp（退出清理，零残留）')
    chosen = 'temp'
  }
  if (chosen === 'usb') {
    return { mode: chosen, engineRoot: appRoot, nodeExe: path.join(appRoot, rel.node), entry: path.join(appRoot, rel.entry), dataRoot: path.join(root, 'data', 'dsh-home') }
  }
  const target = targetRootFor(chosen, appRoot, version)
  if (manifestMatches(target, version, rel)) {
    log(`复用已安装引擎（${chosen}）：${target}`)
  } else {
    log('这台电脑还没有这套引擎：首次使用会先装到本机（约 450–500 MB，通常 10–60 秒）')
    log('你的数据（Key/会话/工作区）仍在 U 盘上，不会写到本机')
    withInstallLock(target, () => manifestMatches(target, version, rel), () => {
      if (hasTar(appRoot)) extractEngineTar(appRoot, target, version, rel)
      else installEngine(appRoot, target, version, rel)
    })
  }
  if (chosen === 'temp') registerTempCleanup(target)
  return { mode: chosen, engineRoot: target, nodeExe: path.join(target, rel.node), entry: path.join(target, rel.entry), dataRoot: path.join(root, 'data', 'dsh-home') }
}

module.exports = { resolveEngine, pickMode, hostEngineBase, nodeRel, entryRel, MANIFEST, ENGINE_TAR, ENGINE_TAR_GZ, ENGINE_JSON, sweepStaleTempEngines }
