/**
 * 设备钱包落盘位置解析 —— u 系列统一规则：**钱包锚定"盘"，不锚定"目录"**。
 *
 * 背景：以前钱包按「数据目录」存，客户换个文件夹/重装/换版本就领到新钱包，
 * 之前充的钱看起来"消失"了（实测一台机器上攒出 4 个钱包，钱在第 3 个里）。
 *
 * 解析顺序（找到就用，绝不新建覆盖）：
 *   1. env UDSH_WALLET_FILE
 *   2. 当前数据目录 <dataDir>/u-dsh-state/device-wallet.json
 *   3. 同卷统一锚点 <vol>/.xiapan/device-wallet.json        ← 新建时写这里
 *   4. 同卷历史位置 <vol>/.u-dsh/device-wallet.json
 *   5. 同卷常见目录 <vol>/{data,u-dsh}/data/u-dsh-state/device-wallet.json
 *   6. 同卷浅扫一层（任意子目录）/data/u-dsh-state/device-wallet.json（跳过 node_modules/engine）
 *   7. 上次使用指针 last-wallet.txt（宿主侧，只存路径不存凭证）
 */
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const WALLET_FILE = 'device-wallet.json'
const ANCHOR_DIR = '.xiapan'
const SKIP_DIRS = new Set(['node_modules', 'engine', 'dist', 'build', '.git', '$RECYCLE.BIN', 'System Volume Information'])

/** 
 * 路径所在"卷根"：/Volumes/X/... → /Volumes/X；F:\... → F:\。
 * 系统盘根（macOS 的 / 或无盘符）返 undefined —— 那不是 U 盘，不该在根上建锚点。
 */
function volumeRoot(target) {
  const forced = process.env.UDSH_WALLET_VOLUME?.trim()
  if (forced) return path.resolve(forced)
  const resolved = path.resolve(target)
  if (path.sep === '/') {
    const match = resolved.match(/^\/Volumes\/[^/]+/)
    return match ? match[0] : undefined
  }
  const parsed = path.parse(resolved)
  return parsed.root || undefined
}


/**
 * 找"插在机器上的、带统一锚点的可移动盘"。
 * Windows 直试 D:..Z:（免 shell，几十次 stat 很快）；macOS 读 /Volumes。
 * @returns {{file: string, volume: string}|undefined}
 */
function findExternalWallet() {
  const candidates = []
  if (path.sep === '\\') {
    for (let code = 'D'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
      candidates.push(`${String.fromCharCode(code)}:\\`)
    }
  } else {
    try {
      for (const name of readdirSync('/Volumes')) candidates.push(path.join('/Volumes', name))
    } catch { return undefined }
  }
  for (const volume of candidates.sort()) {
    const file = path.join(volume, ANCHOR_DIR, WALLET_FILE)
    if (looksLikeWallet(file)) return { file, volume }
  }
  return undefined
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function looksLikeWallet(file) {
  const data = readJsonSafe(file)
  return Boolean(data && typeof data === 'object' && (data.apiKey || data.walletId))
}

function recent(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

/**
 * 解析钱包文件路径。
 * @param {object} opts
 * @param {string} opts.dataDir   当前数据目录（<盘>/data）
 * @param {string} [opts.stateHint] 宿主侧"上次使用"指针文件
 * @returns {{ file: string, source: string, existing: boolean }}
 */
function locateWalletFile({ dataDir, stateHint }) {
  const explicit = process.env.UDSH_WALLET_FILE?.trim()
  if (explicit) return { file: explicit, source: 'env:UDSH_WALLET_FILE', existing: existsSync(explicit) }

  const current = path.join(dataDir, 'u-dsh-state', WALLET_FILE)
  if (looksLikeWallet(current)) return { file: current, source: 'data-dir', existing: true }

  const vol = volumeRoot(dataDir)
  if (vol) {
  const candidates = [
    path.join(vol, ANCHOR_DIR, WALLET_FILE),
    path.join(vol, '.u-dsh', WALLET_FILE),
    path.join(vol, 'data', 'u-dsh-state', WALLET_FILE),
    path.join(vol, 'u-dsh', 'data', 'u-dsh-state', WALLET_FILE),
  ]
  for (const candidate of candidates) {
    if (looksLikeWallet(candidate)) return { file: candidate, source: 'volume-anchor', existing: true }
  }


  // 同卷浅扫一层：客户可能把便携包解压成 <盘>/任意名字/u-dsh/data/...
  try {
    for (const entry of readdirSync(vol, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      const nested = path.join(vol, entry.name, 'data', 'u-dsh-state', WALLET_FILE)
      if (looksLikeWallet(nested)) return { file: nested, source: `volume-scan:${entry.name}`, existing: true }
    }
  } catch { /* 盘根不可读就跳过 */ }
  }

  // 安装到本机的版本（数据目录在 C 盘）：钱包仍然要跟着客户那支 U 盘走 ——
  // 扫所有可移动盘，谁身上有统一锚点就用谁的（顺序稳定：盘符/卷名排序）。
  const external = findExternalWallet()
  if (external) return { file: external.file, source: `external-volume:${external.volume}`, existing: true }

  if (stateHint && existsSync(stateHint)) {
    try {
      const remembered = readFileSync(stateHint, 'utf8').trim()
      if (remembered && looksLikeWallet(remembered)) return { file: remembered, source: 'last-used', existing: true }
    } catch { /* 指针坏了忽略 */ }
  }

  // 都没有：新建在统一锚点（有盘才有锚点；系统盘就退回 data 目录）
  if (vol) {
    return { file: path.join(vol, ANCHOR_DIR, WALLET_FILE), source: 'new-anchor', existing: false }
  }
  return { file: current, source: 'new-data-dir', existing: false }
}

/** 记住这次用的钱包路径（宿主侧指针，只存路径，不存凭证） */
function rememberWalletFile(stateHint, file) {
  if (!stateHint) return
  try {
    mkdirSync(path.dirname(stateHint), { recursive: true })
    writeFileSync(stateHint, `${file}\n`)
  } catch { /* 指针写不了不影响主流程 */ }
}

module.exports = { locateWalletFile, rememberWalletFile, volumeRoot, WALLET_FILE, ANCHOR_DIR }
