/**
 * 纯 Node 标准库实现的 zip 写 / 读 / 校验（零第三方依赖）。
 *
 * 为什么要自己写，不再借 .NET ZipFile / Compress-Archive / bsdtar：
 * 发布包里躺着 .command（macOS 双击启动器），zip 一丢执行位、一写反斜杠，用户拿到就废。
 * 这三样东西各自都缺一角：
 *   - .NET `ZipFile.CreateFromDirectory`：条目名用反斜杠，external_attr 恒 0（wood exec bit 全丢）
 *   - PowerShell `Compress-Archive`：按 OEM 码页写非 ASCII 名字 → 「启动 U-DSH Web.bat」乱码
 *   - bsdtar（macOS 自带）：名字、执行位都对，但换行原样搬，Windows 检出带上来的 CRLF 直接进包
 * 而 zip 格式本身这三件事都能表达清楚，只是要有人按规矩写：
 *   1. 条目名一律正斜杠（APPNOTE 4.4.17.1 规定目录分隔符是 `/`）；
 *   2. POSIX 权限位写进 central directory 的 external_attr 高 16 位（`mode << 16`）；
 *   3. 文本按目标平台换行写（POSIX 脚本 LF、Windows 脚本 CRLF），不依赖检出机的 git 配置。
 *
 * 本模块只做「把一个目录写成 zip」和「把一个 zip 读出来体检」两件事，不碰业务。
 * 写入器限制：单条目 / 整体偏移不超过 4 GiB（不生成 zip64）。便携包实测 ~170 MB，
 * 越界时明确报错而不是写出坏包。
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** POSIX shell 脚本：必须有执行位，且必须 LF（CRLF 会让 `#!/bin/bash\r` 变 bad interpreter）。 */
export const POSIX_SCRIPT_EXTS = new Set(['.command', '.sh', '.bash', '.zsh'])

/** Windows 脚本：文件必须存在、但换行必须是 CRLF（cmd.exe / Windows PowerShell 5 有解析坑）。 */
export const WINDOWS_SCRIPT_EXTS = new Set(['.bat', '.cmd', '.ps1', '.psm1'])

/** 其余按 LF 写的文本。 */
export const LF_TEXT_EXTS = new Set([
  '.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx',
  '.json', '.json5', '.map', '.yml', '.yaml',
  '.md', '.txt', '.html', '.css', '.svg', '.csv',
])

/** 已压缩/二进制：不再 deflate（白烧 CPU，还可能变大），也绝不参与换行转换。 */
export const BINARY_EXTS = new Set([
  '.exe', '.dll', '.node', '.so', '.dylib',
  '.gz', '.tgz', '.zip', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.asar',
])

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const DOS_DIR_ATTR = 0x10
const FLAG_UTF8 = 0x0800
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const ZIP32_MAX = 0xffffffff
const ZIP16_MAX = 0xffff
// version made by：高字节 3 = Unix（只有这样 unzip 才会去读 external_attr 的权限位），低字节 20 = 2.0
const VERSION_MADE_BY = (3 << 8) | 20
const VERSION_NEEDED = 20

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间戳（本地时间，2 秒精度，1980–2107）。 */
function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  }
}

function toLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function isTextLike(buffer, ext) {
  if (BINARY_EXTS.has(ext)) return false
  // 内容里出现 NUL 就按二进制处理：宁可原样搬运，也不要把二进制写坏。
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)
}

/**
 * 按目标平台规整文本换行，返回新 buffer 与原 buffer 相比是否真的改过。
 * POSIX 脚本额外去掉 UTF-8 BOM —— `\ufeff#!/bin/bash` 不是 shebang，execve 直接 ENOEXEC。
 * `.bat` 刻意不动 BOM：那是打包前就存在的字节，改它属于另一件事（换行以外的内容变更）。
 */
export function normalizeLineEndings(buffer, ext) {
  if (!isTextLike(buffer, ext)) return { buffer, changed: false }
  let text = buffer.toString('utf8')
  if (POSIX_SCRIPT_EXTS.has(ext) && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = toLf(text)
  if (WINDOWS_SCRIPT_EXTS.has(ext)) text = text.replace(/\n/g, '\r\n')
  const next = Buffer.from(text, 'utf8')
  return { buffer: next, changed: !next.equals(buffer) }
}

/** 可执行判定：POSIX 脚本扩展名 ∪ 源文件带执行位 ∪ 内容以 `#!` 开头（覆盖 .mjs/.cjs 脚本）。 */
export function isExecutableEntry(entryPath, data, sourceMode = 0) {
  const ext = path.extname(entryPath).toLowerCase()
  if (POSIX_SCRIPT_EXTS.has(ext)) return true
  if ((sourceMode & 0o111) !== 0) return true
  return data.length >= 2 && data[0] === 0x23 && data[1] === 0x21
}

function normalizeEntryName(rawName) {
  if (rawName.includes('\\')) {
    throw new Error(`条目名含反斜杠，zip 里无法无歧义表示（会被解压器当分隔符）：${rawName}`)
  }
  // NFC：macOS 的 APFS 交出来的是 NFD，原样写进 zip 会让 Windows/Linux 上的中文名对不上。
  return rawName.normalize('NFC')
}

function writeAll(fd, buffer) {
  let written = 0
  while (written < buffer.length) written += writeSync(fd, buffer, written)
}

function compressEntry(raw) {
  if (raw.length === 0) return { method: 0, payload: raw }
  const deflated = zlib.deflateRawSync(raw, { level: 6 })
  // 压不动就存原文：.exe 之外的已压缩内容（.gz/.zip/.png）经常越压越大。
  if (deflated.length >= raw.length) return { method: 0, payload: raw }
  return { method: 8, payload: deflated }
}

/**
 * 把一个目录树写成 zip 文件，跨平台行为完全一致（Win/mac/Linux 走同一段代码）。
 *
 * @param {object} options
 * @param {string} options.sourceDir        要打包的目录
 * @param {string} options.zipPath          产物路径（先写 .tmp 再 rename，不留半个包）
 * @param {boolean} [options.includeBaseDirectory=true] 条目是否带 `sourceDir` 的目录名做前缀
 * @param {(msg: string) => void} [options.log]
 * @returns {{ zipPath: string, entryCount: number, fileCount: number, directoryCount: number,
 *             executableCount: number, convertedCrlfCount: number, bytes: number }}
 */
export function createZipFromDirectory({ sourceDir, zipPath, includeBaseDirectory = true, log = () => {} }) {
  const entries = collectEntries(sourceDir, includeBaseDirectory ? path.basename(sourceDir) : '')
  if (entries.length === 0) throw new Error(`目录是空的，没什么可打包：${sourceDir}`)
  if (entries.length > ZIP16_MAX) throw new Error(`条目数 ${entries.length} 超过 zip32 上限 ${ZIP16_MAX}`)

  const tmpPath = `${zipPath}.tmp`
  mkdirSync(path.dirname(zipPath), { recursive: true })
  rmSync(tmpPath, { force: true })
  const fd = openSync(tmpPath, 'w')
  const central = []
  let offset = 0
  let executableCount = 0
  let convertedCrlfCount = 0

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8')
      const raw = entry.isDirectory ? Buffer.alloc(0) : entry.data
      const { method, payload } = entry.isDirectory ? { method: 0, payload: raw } : compressEntry(raw)
      const crc = crc32(raw)
      const { date, time } = dosDateTime(entry.mtimeMs)
      const mode = entry.isDirectory ? S_IFDIR | 0o755 : S_IFREG | (entry.executable ? 0o755 : 0o644)
      const externalAttr = ((mode << 16) | (entry.isDirectory ? DOS_DIR_ATTR : 0)) >>> 0
      if (raw.length > ZIP32_MAX || payload.length > ZIP32_MAX) {
        throw new Error(`条目 ${entry.name} 超过 4 GiB，本写入器不支持 zip64`)
      }
      if (offset > ZIP32_MAX) throw new Error(`累计偏移超过 4 GiB，本写入器不支持 zip64：${entry.name}`)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(VERSION_NEEDED, 4)
      local.writeUInt16LE(FLAG_UTF8, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)

      writeAll(fd, local)
      writeAll(fd, nameBuf)
      if (payload.length > 0) writeAll(fd, payload)

      central.push({ nameBuf, method, time, date, crc, compressedSize: payload.length, uncompressedSize: raw.length, externalAttr, offset })
      offset += 30 + nameBuf.length + payload.length
      if (entry.executable) executableCount += 1
      if (entry.convertedCrlf) convertedCrlfCount += 1
    }

    let cdSize = 0
    for (const record of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(SIG_CENTRAL, 0)
      header.writeUInt16LE(VERSION_MADE_BY, 4)
      header.writeUInt16LE(VERSION_NEEDED, 6)
      header.writeUInt16LE(FLAG_UTF8, 8)
      header.writeUInt16LE(record.method, 10)
      header.writeUInt16LE(record.time, 12)
      header.writeUInt16LE(record.date, 14)
      header.writeUInt32LE(record.crc, 16)
      header.writeUInt32LE(record.compressedSize, 20)
      header.writeUInt32LE(record.uncompressedSize, 24)
      header.writeUInt16LE(record.nameBuf.length, 28)
      header.writeUInt16LE(0, 30) // extra
      header.writeUInt16LE(0, 32) // comment
      header.writeUInt16LE(0, 34) // disk start
      header.writeUInt16LE(0, 36) // internal attrs
      header.writeUInt32LE(record.externalAttr, 38)
      header.writeUInt32LE(record.offset, 42)
      writeAll(fd, header)
      writeAll(fd, record.nameBuf)
      cdSize += 46 + record.nameBuf.length
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    writeAll(fd, eocd)
  } finally {
    closeSync(fd)
  }

  renameSync(tmpPath, zipPath)
  const directoryCount = entries.filter((e) => e.isDirectory).length
  const result = {
    zipPath,
    entryCount: entries.length,
    fileCount: entries.length - directoryCount,
    directoryCount,
    executableCount,
    convertedCrlfCount,
    bytes: statSync(zipPath).size,
  }
  log(`zip 写入完成：${result.entryCount} 条目（${result.directoryCount} 目录 / ${result.fileCount} 文件）`)
  return result
}

/** 递归收集条目：目录条目以 `/` 结尾排在子项之前，名字排序保证产物可重复。 */
function collectEntries(sourceDir, prefix) {
  const out = []
  if (prefix) {
    // 根目录也写成条目：`unzip -d` 之外的解压器（以及 Windows 资源管理器）据此建顶层目录。
    out.push({ name: `${normalizeEntryName(prefix)}/`, isDirectory: true, mtimeMs: statSync(sourceDir).mtimeMs })
  }
  const walk = (dir, relPrefix) => {
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      const full = path.join(dir, name)
      let stats
      try {
        stats = statSync(full) // 跟随 symlink：包里要的是内容，不是宿主机的链接
      } catch (error) {
        throw new Error(`读不了 ${full}：${error.message}`)
      }
      const rel = relPrefix ? `${relPrefix}/${name}` : name
      const entryName = normalizeEntryName(rel)
      if (stats.isDirectory()) {
        out.push({ name: `${entryName}/`, isDirectory: true, mtimeMs: stats.mtimeMs })
        walk(full, rel)
      } else if (stats.isFile()) {
        const original = readFileSync(full)
        const ext = path.extname(name).toLowerCase()
        const { buffer, changed } = normalizeLineEndings(original, ext)
        out.push({
          name: entryName,
          isDirectory: false,
          data: buffer,
          mtimeMs: stats.mtimeMs,
          executable: isExecutableEntry(name, buffer, stats.mode),
          convertedCrlf: changed,
        })
      } else {
        throw new Error(`不支持的文件类型（不是普通文件/目录）：${full}`)
      }
    }
  }
  walk(sourceDir, prefix)
  return out
}

/** 读 zip：只支持 zip32（本仓库产物都是 zip32），遇到 zip64 明确报错。 */
export function readZipArchive(buffer, { withData = true } = {}) {
  const eocd = findEocd(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  let pointer = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(pointer) !== SIG_CENTRAL) throw new Error(`中央目录第 ${i} 条签名不对（偏移 ${pointer}）`)
    const flags = buffer.readUInt16LE(pointer + 8)
    const method = buffer.readUInt16LE(pointer + 10)
    const time = buffer.readUInt16LE(pointer + 12)
    const date = buffer.readUInt16LE(pointer + 14)
    const crc = buffer.readUInt32LE(pointer + 16)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const uncompressedSize = buffer.readUInt32LE(pointer + 24)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const externalAttr = buffer.readUInt32LE(pointer + 38)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    if (compressedSize === ZIP32_MAX || localOffset === ZIP32_MAX) throw new Error('这是 zip64 包，本模块只读 zip32')
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    const entry = {
      name,
      flags,
      method,
      time,
      date,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      externalAttr,
      unixMode: (externalAttr >>> 16) & 0xffff,
      dosAttr: externalAttr & 0xff,
      localOffset,
      isDirectory: name.endsWith('/'),
    }
    if (withData) entry.data = readEntryData(buffer, entry)
    entries.push(entry)
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) !== SIG_EOCD) continue
    const commentLength = buffer.readUInt16LE(i + 20)
    if (i + 22 + commentLength === buffer.length) return i
  }
  throw new Error('不是有效的 zip：找不到结束记录（EOCD）')
}

function readEntryData(buffer, entry) {
  const local = entry.localOffset
  if (buffer.readUInt32LE(local) !== SIG_LOCAL) throw new Error(`条目 ${entry.name} 的本地头签名不对`)
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const payload = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(payload)
  if (entry.method === 8) return zlib.inflateRawSync(payload)
  throw new Error(`条目 ${entry.name} 用了不支持的压缩方法 ${entry.method}`)
}

const hasNonAscii = (name) => /[^\x00-\x7f]/.test(name)

/**
 * 体检一个 zip（不认识业务，只认「POSIX 解压友好」这一套硬规矩）。
 * 返回的问题都是可定位到具体条目的，便于 CI 直接贴出来。
 */
export function verifyZipArchive(buffer, { requireExecutable = POSIX_SCRIPT_EXTS, withData = true } = {}) {
  const entries = readZipArchive(buffer, { withData })
  const problems = []
  const push = (code, entry, message) => problems.push({ code, entry: entry?.name ?? null, message })
  const seen = new Set()
  let executableCount = 0

  for (const entry of entries) {
    const ext = path.extname(entry.name).toLowerCase()

    if (entry.name.includes('\\')) push('name-backslash', entry, '条目名含反斜杠，部分解压器会解出怪路径')
    if (entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name)) push('name-absolute', entry, '条目名是绝对路径')
    if (entry.name.split('/').some((part) => part === '..')) push('name-traversal', entry, '条目名含 ..，会被解压到目录外')
    if (entry.name !== entry.name.normalize('NFC')) push('name-not-nfc', entry, '条目名不是 NFC，跨平台中文名会对不上')
    if (hasNonAscii(entry.name) && (entry.flags & FLAG_UTF8) === 0) {
      push('name-utf8-flag-missing', entry, '非 ASCII 名字没置 UTF-8 标志（0x800），Windows 会按 OEM 码页解出乱码')
    }
    if (entry.name === '') push('name-empty', entry, '空条目名')
    if (seen.has(entry.name)) push('duplicate-name', entry, '同名条目出现两次')
    seen.add(entry.name)

    if (entry.unixMode === 0) {
      push('unix-mode-missing', entry, 'external_attr 里没有 POSIX 权限位（高位全 0），解压后执行位全丢')
    } else {
      const recordedDir = (entry.unixMode & 0o170000) === S_IFDIR
      if (recordedDir !== entry.isDirectory) {
        push('entry-type-mismatch', entry, '条目类型位（目录/普通文件）与名字是否以 / 结尾不一致')
      }
    }
    if (entry.isDirectory && entry.name.endsWith('//')) {
      push('directory-entry-malformed', entry, '目录条目必须以单个 / 结尾')
    }

    const mode = entry.unixMode & 0o777
    if (requireExecutable.has(ext) && mode !== 0o755) {
      push('exec-bit-missing', entry, `${ext} 脚本应为 0o755，实际 ${mode.toString(8)}`)
    }
    if (mode & 0o111 && !entry.isDirectory) executableCount += 1
    // 带 shebang 的条目（.mjs/.cjs 脚本）同样应当可执行，否则 `./tool.mjs` 直接 EACCES。
    const isShebang = entry.data && entry.data.length >= 2 && entry.data[0] === 0x23 && entry.data[1] === 0x21
    if (isShebang && !entry.isDirectory && (mode & 0o111) === 0) {
      push('exec-bit-missing', entry, '内容以 #! 开头但没有执行位')
    }

    if (entry.data) {
      const hasCr = entry.data.includes(0x0d)
      if (POSIX_SCRIPT_EXTS.has(ext) && hasCr) {
        push('crlf-in-posix-script', entry, `${ext} 里有 CR：macOS 双击会报 bad interpreter / ^M`)
      } else if (LF_TEXT_EXTS.has(ext) && hasCr) {
        push('crlf-in-text-entry', entry, `${ext} 文本不是纯 LF`)
      }
      if (WINDOWS_SCRIPT_EXTS.has(ext) && entry.data.includes(0x0a) && !entry.data.includes(0x0d)) {
        push('crlf-missing-in-windows-script', entry, `${ext} 必须是 CRLF，cmd.exe 从 LF-only 批处理读到的最后一行可能缺失`)
      }
      if (!entry.isDirectory) {
        if (entry.data.length !== entry.uncompressedSize) {
          push('size-mismatch', entry, '解出来的长度与中央目录记录不一致')
        } else if (crc32(entry.data) !== entry.crc32) {
          push('crc-mismatch', entry, '解出来的内容 CRC32 与记录不符（包损坏）')
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    entries,
    summary: {
      entryCount: entries.length,
      directoryCount: entries.filter((e) => e.isDirectory).length,
      fileCount: entries.filter((e) => !e.isDirectory).length,
      executableCount,
      bytes: buffer.length,
    },
  }
}

/** 便捷入口：直接读文件体检。 */
export function verifyZipFile(zipPath, options) {
  return verifyZipArchive(readFileSync(zipPath), options)
}
