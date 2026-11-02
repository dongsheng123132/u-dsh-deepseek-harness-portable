/**
 * 发布包 zip 的打包回归：条目名分隔符、POSIX 执行位、换行、目录条目。
 *
 * 这些断言对应的都是「解压成功但用户用不了」的真实故障，不是洁癖：
 *   - `u-dsh\启动 U-DSH Web.command`（反斜杠）→ 部分解压器解出怪路径 / macOS 找不到启动器
 *   - external_attr 高位为 0（.NET ZipFile 的产物）→ .command 解出来 0644，双击报权限不足
 *   - `.command` 里带 CR → macOS 报 `bad interpreter: /bin/bash^M`
 * 老实现（.NET ZipFile / bsdtar）打出来的包在 test/zip-packaging.test.js 里用
 * `buildLegacyZipLikeDotNet()` 精确复刻，验证脚本必须能把它判红 —— 否则「体检通过」毫无意义。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, createZipFromDirectory, readZipArchive, verifyZipArchive } from '../scripts/lib/zip-archive.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLOSE_FLAG = 0x0800 // UTF-8 名字标志

function makeFixtureTree() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'udsh-zip-'))
  const root = path.join(base, 'u-dsh')
  mkdirSync(path.join(root, 'data', 'dsh-home'), { recursive: true })
  mkdirSync(path.join(root, 'resources', 'app', 'runtime', 'node-win-x64'), { recursive: true })
  mkdirSync(path.join(root, 'tools'), { recursive: true })
  // 模拟 Windows 检出：带 BOM、CRLF
  writeFileSync(path.join(root, '启动 U-DSH Web.command'), '\ufeff#!/bin/bash\r\ncd "$(dirname "$0")"\r\nexec ./run\r\n', 'utf8')
  // 模拟 LF 检出的 .bat（.gitattributes 会给 CRLF，但打包器不该指望检出机的配置）
  writeFileSync(path.join(root, '启动 U-DSH Web.bat'), '@echo off\necho hi\n', 'utf8')
  writeFileSync(path.join(root, 'README.md'), '# U-DSH\r\n\r\n中文说明\n', 'utf8')
  writeFileSync(path.join(root, 'tools', 'tool.mjs'), '#!/usr/bin/env node\nconsole.log(1)\n', 'utf8')
  writeFileSync(path.join(root, 'resources', 'app', 'web-launch.cjs'), "'use strict'\n// cjs\n", 'utf8')
  writeFileSync(path.join(root, 'resources', 'app', 'engine.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x0d, 0x0a, 0x00]))
  writeFileSync(path.join(root, 'resources', 'app', 'runtime', 'node-win-x64', 'node.exe'), Buffer.from('MZ\x00\x00binary\r\n', 'latin1'))
  return { base, root }
}

/** 复刻老 .NET `ZipFile.CreateFromDirectory` 的产物特征：反斜杠条目名 + external_attr=0。 */
function buildLegacyZipLikeDotNet(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const data = file.data
    const crc = crc32(data)
    const flags = /[^\x00-\x7f]/.test(file.name) ? CLOSE_FLAG : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x5021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // create_system = 0（FAT）—— 正是 .NET 的行为
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x5021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38) // external_attr = 0x00000000 —— 执行位/类型位全丢
    central.writeUInt32LE(offset, 42)

    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

test('新打包器：正斜杠条目名、目录条目带 /、附 POSIX 权限位', (t) => {
  const { base, root } = makeFixtureTree()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const zipPath = path.join(base, 'pkg.zip')
  const written = createZipFromDirectory({ sourceDir: root, zipPath, includeBaseDirectory: true })

  assert.ok(written.entryCount > 0)
  const entries = readZipArchive(readFileSync(zipPath))
  const names = entries.map((e) => e.name)

  for (const entry of entries) {
    assert.ok(!entry.name.includes('\\'), `条目名不能有反斜杠：${entry.name}`)
    assert.equal(entry.name, entry.name.normalize('NFC'))
    assert.notEqual(entry.unixMode, 0, `条目缺 POSIX 权限位：${entry.name}`)
    if (/[^\x00-\x7f]/.test(entry.name)) assert.ok(entry.flags & CLOSE_FLAG, `非 ASCII 名字缺 UTF-8 标志：${entry.name}`)
  }

  // 目录条目：以 / 结尾且是 S_IFDIR
  const dirs = entries.filter((e) => e.isDirectory)
  assert.ok(dirs.length >= 3, `应当有目录条目，实际 ${dirs.length}`)
  for (const dir of dirs) {
    assert.ok(dir.name.endsWith('/'))
    assert.equal(dir.unixMode & 0o170000, 0o040000, `不是目录类型：${dir.name}`)
  }
  assert.ok(names.includes('u-dsh/data/dsh-home/'))
  assert.ok(names.includes('u-dsh/resources/app/runtime/node-win-x64/node.exe'))

  // 文件条目：类型位 + 权限位
  const byName = new Map(entries.map((e) => [e.name, e]))
  const launcher = byName.get('u-dsh/启动 U-DSH Web.command')
  assert.ok(launcher, '缺少 macOS 启动器条目')
  assert.equal(launcher.unixMode & 0o170000, 0o100000)
  assert.equal(launcher.unixMode & 0o777, 0o755, '.command 必须是 0755')
  assert.equal(byName.get('u-dsh/README.md').unixMode & 0o777, 0o644)
  assert.equal(byName.get('u-dsh/tools/tool.mjs').unixMode & 0o777, 0o755, '带 shebang 的 .mjs 应当可执行')
  assert.equal(byName.get('u-dsh/resources/app/web-launch.cjs').unixMode & 0o777, 0o644)
})

test('新打包器：POSIX 脚本写 LF（去 BOM），Windows 脚本写 CRLF，二进制原样', (t) => {
  const { base, root } = makeFixtureTree()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const zipPath = path.join(base, 'pkg.zip')
  createZipFromDirectory({ sourceDir: root, zipPath, includeBaseDirectory: true })
  const entries = new Map(readZipArchive(readFileSync(zipPath)).map((e) => [e.name, e]))

  const launcher = entries.get('u-dsh/启动 U-DSH Web.command')
  const launcherText = launcher.data.toString('utf8')
  assert.ok(!launcherText.includes('\r'), '.command 里不能有 CR')
  assert.ok(launcherText.startsWith('#!/bin/bash\n'), `shebang 前不能有 BOM/CR：${JSON.stringify(launcherText.slice(0, 16))}`)

  assert.equal(entries.get('u-dsh/启动 U-DSH Web.bat').data.toString('utf8'), '@echo off\r\necho hi\r\n')
  assert.ok(!entries.get('u-dsh/README.md').data.toString('utf8').includes('\r'))
  // 二进制不许被换行规整碰过
  assert.deepEqual([...entries.get('u-dsh/resources/app/runtime/node-win-x64/node.exe').data], [...Buffer.from('MZ\x00\x00binary\r\n', 'latin1')])

  // 打包不该改动源目录（构建目录后面还要给 verify-engine-install 用）
  assert.ok(readFileSync(path.join(root, '启动 U-DSH Web.command'), 'utf8').includes('\r\n'), '源文件不应被就地改写')
})

test('新打包器：产物通过体检，且逐条 CRC 正确', (t) => {
  const { base, root } = makeFixtureTree()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const zipPath = path.join(base, 'pkg.zip')
  createZipFromDirectory({ sourceDir: root, zipPath, includeBaseDirectory: true })

  const report = verifyZipArchive(readFileSync(zipPath))
  assert.deepEqual(report.problems, [], `不应有问题：${JSON.stringify(report.problems, null, 2)}`)
  assert.equal(report.ok, true)
  assert.equal(report.summary.directoryCount, 8) // u-dsh/、data/、data/dsh-home/、resources/、resources/app/、
  // resources/app/runtime/、resources/app/runtime/node-win-x64/、tools/
  assert.equal(report.summary.executableCount, 2) // .command + 带 shebang 的 .mjs
})

test('老 .NET ZipFile 产物：体检必须判红（反斜杠 / 无权限位 / CRLF）', () => {
  const legacy = buildLegacyZipLikeDotNet([
    { name: 'u-dsh\\启动 U-DSH Web.command', data: Buffer.from('#!/bin/bash\r\nexec ./run\r\n') },
    { name: 'u-dsh\\data\\dsh-home\\', data: Buffer.alloc(0) },
    { name: 'u-dsh\\README.md', data: Buffer.from('# hi\n') },
  ])
  const report = verifyZipArchive(legacy)
  assert.equal(report.ok, false)
  const codes = new Set(report.problems.map((p) => p.code))
  for (const expected of ['name-backslash', 'unix-mode-missing', 'exec-bit-missing', 'crlf-in-posix-script']) {
    assert.ok(codes.has(expected), `体检没抓到 ${expected}，实际只报了 ${[...codes].join(', ')}`)
  }
  // 目录条目结尾是 `\` 而不是 `/`，解压器会把它当普通文件
  const dirEntry = report.entries.find((e) => e.name.endsWith('\\'))
  assert.ok(dirEntry)
  assert.equal(dirEntry.isDirectory, false)
})

test('CRLF 的 .command（bsdtar 路径的原样搬运）必须判红', () => {
  const crlf = Buffer.from('#!/bin/bash\r\nexec ./run\r\n')
  const zip = buildLegacyZipLikeDotNet([
    { name: 'u-dsh/启动 U-DSH Web.command', data: crlf },
    { name: 'u-dsh/data/dsh-home/', data: Buffer.alloc(0) },
  ])
  const report = verifyZipArchive(zip)
  assert.equal(report.ok, false)
  const problem = report.problems.find((p) => p.code === 'crlf-in-posix-script')
  assert.ok(problem, `应当报 CRLF：${JSON.stringify(report.problems)}`)
  assert.equal(problem.entry, 'u-dsh/启动 U-DSH Web.command')
})

test('verify-zip CLI：好包退出码 0，老包退出码 1', (t) => {
  const { base, root } = makeFixtureTree()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const goodZip = path.join(base, 'good.zip')
  createZipFromDirectory({ sourceDir: root, zipPath: goodZip, includeBaseDirectory: true })

  const good = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-zip.mjs'), goodZip], { encoding: 'utf8' })
  assert.equal(good.status, 0, `好包应通过：${good.stdout}${good.stderr}`)
  assert.match(good.stdout, /✓ 通过/)

  const badZip = path.join(base, 'bad.zip')
  writeFileSync(badZip, buildLegacyZipLikeDotNet([{ name: 'u-dsh\\启动 U-DSH Web.command', data: Buffer.from('#!/bin/bash\r\n') }]))
  const bad = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-zip.mjs'), badZip], { encoding: 'utf8' })
  assert.equal(bad.status, 1, `老包必须判红：${bad.stdout}`)
  assert.match(bad.stdout, /name-backslash/)
})

test('含反斜杠的源文件名直接报错（zip 无法无歧义表示）', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'udsh-zip-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'u-dsh')
  mkdirSync(root, { recursive: true })
  if (process.platform === 'win32') return // Windows 文件名不允许反斜杠，这条只对 POSIX 有意义
  writeFileSync(path.join(root, 'weird\\name.txt'), 'x')
  assert.throws(() => createZipFromDirectory({ sourceDir: root, zipPath: path.join(base, 'x.zip') }), /反斜杠/)
})
