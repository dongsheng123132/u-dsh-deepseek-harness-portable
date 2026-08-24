#!/usr/bin/env node
/**
 * 把 win-unpacked 打成 7-Zip 自解压 exe（SFX）。
 *
 * 为什么需要：发布包里是 DSH 的完整依赖闭包，**34987 个文件**。瓶颈是文件数量，
 * 不是体积。同一台机器、同一个包实测：
 *
 *     Expand-Archive（= 资源管理器「全部解压缩」）   580 秒
 *     7z x                                            51 秒     ← 快 11.4 倍
 *
 * 干净云主机（2 核）上 Expand-Archive 实测 1233 秒（20.5 分钟）。用户下载完还要
 * 干等 20 分钟、全程没有进度条 —— 关键词做得再好，人也在这一步走光了。
 * 竞品 dsh-usb 的 README 自曝「可能耗时大于 30min」，撞的是同一堵墙。
 *
 * SFX 同时解决两件事：解压快一个数量级，且 7z 的 SFX 模块自带进度窗口，
 * 用户看得见在动。
 *
 * 产物与 zip **并存**，不替代：zip 留给会用解压工具的人和自动化，
 * exe 给「双击就想用」的普通用户。
 *
 * 用法：node scripts/build-sfx.mjs   （需先 npm run dist:portable 产出 dist/win-unpacked）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpacked = path.join(root, 'dist', 'win-unpacked')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const archive = path.join(root, 'dist', `.sfx-payload-${version}.7z`)
const output = path.join(root, 'dist', `U-DSH-DeepSeek-Harness-Portable-${version}-Windows-x64.exe`)

const SEVEN_ZIP_CANDIDATES = [
  process.env.UDSH_SEVEN_ZIP,
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
].filter(Boolean)

function fail(message) {
  process.stderr.write(`build-sfx: ${message}\n`)
  process.exit(1)
}

function log(message) {
  process.stdout.write(`build-sfx: ${message}\n`)
}

const sevenZip = SEVEN_ZIP_CANDIDATES.find((candidate) => existsSync(candidate))
if (!sevenZip) fail(`找不到 7z.exe，试过：${SEVEN_ZIP_CANDIDATES.join('、')}。可用 UDSH_SEVEN_ZIP 指定。`)

const sfxModule = path.join(path.dirname(sevenZip), '7z.sfx')
if (!existsSync(sfxModule)) fail(`找不到 SFX 模块 ${sfxModule}`)
if (!existsSync(unpacked)) fail(`找不到 ${path.relative(root, unpacked)}，请先跑 npm run dist:portable`)

// 每次重来，别把上一轮的残留混进去。
for (const stale of [archive, output]) {
  if (existsSync(stale)) unlinkSync(stale)
}

// 便携软件的数据目录就在 exe 旁边，所以只要有人从 win-unpacked 里启动过一次
// （冒烟测试就会），data/ 就会长出来。空目录无害，但**带真钱包跑过一次的话，
// 设备 Key 就在 data/u-dsh-state/device-wallet.json 里** —— 那会随包发给所有人。
// 宁可在这里失败，也不能把凭据打进发布包。
const dataDir = path.join(unpacked, 'data')
if (existsSync(dataDir)) {
  const leaked = spawnSync('git', ['grep', '-rlIE', 'sk-[A-Za-z0-9]{10,}', '--no-index', '--', dataDir], {
    encoding: 'utf8',
  })
  if (leaked.stdout?.trim()) {
    fail(`拒绝打包：${path.relative(root, dataDir)} 里有疑似凭据\n${leaked.stdout.trim()}\n先删掉整个 data 目录再重来。`)
  }
}

// 打包清单：显式列出顶层条目、跳过运行期 data/。
//
// 为什么不用 `7z a archive <unpacked>/* -xr!data`？-x!data 的匹配是**按条目名、不分
// 深度**的（`r` 递归只是让规则也作用于目录内部），而内核依赖里恰好有必须发布的
// data 目录 —— v0.2.0 的 SFX 就这样把 @earendil-works/pi-ai/dist/providers/data/
// 等四处内核文件排掉了，客户机启动必现 ERR_MODULE_NOT_FOUND「启动失败」弹窗。
// （zip 载荷由 electron-builder 打的，没有这个问题；SFX 和 zip 并存时只有 SFX 坏。）
//
// 显式传顶层条目时 cwd 必须是 unpacked 本身（传 `<unpacked>/xxx` 会把前缀带进归档，
// SFX 的 InstallPath 是 %%T\U-DSH，多一层目录用户解压完找不到 exe）。实测 7z 对
// 显式传入的目录条目会原样收进归档路径，不带 ./ 前缀。
const payloadEntries = readdirSync(unpacked, { withFileTypes: true })
  .filter((entry) => entry.name !== 'data')
  .map((entry) => `./${entry.name}`)
if (payloadEntries.length === 0) fail(`${path.relative(root, unpacked)} 里没有任何可打包的内容`)

log(`压缩 ${payloadEntries.length} 个顶层条目 …（几万个小文件，需要几分钟）`)
// -mx=5 是刻意的折中：-mx=9 能再小一点，但压缩耗时翻几倍，而用户在意的是
// 下载体积和**解压速度**，解压速度跟压缩等级基本无关。
const compress = spawnSync(sevenZip, ['a', '-t7z', '-mx=5', '-mmt=on', '-bso0', '-bsp0', archive, ...payloadEntries], {
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: unpacked,
})
if (compress.status !== 0) fail(`7z 压缩失败，退出码 ${String(compress.status)}`)

// SFX 配置：解压到用户选的目录下的 U-DSH\，完成后不自动运行 ——
// 便携软件自作主张启动会吓到人，让用户自己双击。
const config = [
  ';!@Install@!UTF-8!',
  'Title="U-DSH Portable ' + version + '"',
  'BeginPrompt="将 U-DSH Portable 解压到所选目录。\\n\\n'
    + '注意：U 盘/移动盘必须是 NTFS 格式，exFAT 无法运行。\\n'
    + '包内有约 35000 个文件，解压需要几分钟，请勿中断。\\n\\n是否继续？"',
  'ExtractTitle="正在解压 U-DSH Portable…"',
  'ExtractDialogText="首次解压需要几分钟，之后每次启动都是秒级。"',
  'GUIMode="1"',
  'InstallPath="%%T\\\\U-DSH"',
  ';!@InstallEnd@!',
  '',
].join('\r\n')
const configFile = path.join(root, 'dist', `.sfx-config-${version}.txt`)
writeFileSync(configFile, config, 'utf8')

log('拼装自解压 exe …')
// SFX = 模块 + 配置 + 7z 载荷，三段字节直接首尾相接。
const parts = [sfxModule, configFile, archive].map((file) => readFileSync(file))
writeFileSync(output, Buffer.concat(parts))

for (const temporary of [archive, configFile]) {
  if (existsSync(temporary)) unlinkSync(temporary)
}

const megabytes = (statSync(output).size / 1024 / 1024).toFixed(1)
log(`完成：${path.relative(root, output)}（${megabytes}MB）`)
