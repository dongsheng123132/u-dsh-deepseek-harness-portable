#!/usr/bin/env node
/**
 * 构建时把「Node 运行时 + @deepseek-ai/dsh 完整依赖闭包」vendor 进仓库的
 * vendor/ 目录，随后由 electron-builder 的 extraResources 原样打进发布包。
 * 客户机一行 npm 都不跑、一个字节都不下载——所有网络与安装动作只发生在
 * 这台开发/构建机上。
 *
 * 产出（都不进 git）：
 *   vendor/runtime/win32-x64/  随包 Node 运行时（SHA-256 校验，删 include/）
 *   vendor/harness/            DSH 闭包：package.json + node_modules/
 *
 * 用法：
 *   node scripts/prepare-vendor.mjs           # 需要网络，生成/刷新 vendor
 *   node scripts/prepare-vendor.mjs --force   # 忽略已有产物，强制重做
 *   node scripts/prepare-vendor.mjs --check   # 不联网，只校验产物与
 *                                             # config/runtime-channel.json 一致，
 *                                             # 不一致退出码 1（dist 链的门禁）
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { missingRequiredPeers, sha256, validateDshAt } from '../src/harness-validate.js'
import { loadRuntimeChannel } from '../src/runtime-channel.js'
import { prepareApiProxy } from './patch-harness-apiproxy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = path.join(root, 'vendor')
const runtimeTarget = 'win32-x64'
const runtimeDir = path.join(vendorDir, 'runtime', runtimeTarget)
const runtimeStampFile = path.join(runtimeDir, '.udsh-runtime.json')
const harnessDir = path.join(vendorDir, 'harness')
const checkMode = process.argv.includes('--check')
const forceMode = process.argv.includes('--force')
const channel = loadRuntimeChannel()

function assertChild(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作 vendor 目录之外的路径：${candidate}`)
  }
}

function log(message) {
  process.stdout.write(`prepare-vendor: ${message}\n`)
}

function fail(message) {
  process.stderr.write(`prepare-vendor: ${message}\n`)
  process.exitCode = 1
}

function run(command, args, { timeoutMs = 10 * 60_000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr })
      else finish(reject, new Error(`${path.basename(command)} 退出码 ${code ?? 'unknown'}：${stderr.slice(-1600)}`))
    })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`${path.basename(command)} 超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成`))
    }, timeoutMs)
  })
}

/** npm 在构建机上跑：优先复用当前 npm（npm run 会设 npm_execpath），并剥掉
 *  npm run 注入的 npm_config_* 环境，避免开发机 .npmrc/代理配置串进安装。 */
function npmInstallEnvironment() {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_(config|package|lifecycle)_/i.test(key)) continue
    environment[key] = value
  }
  environment.npm_config_update_notifier = 'false'
  return environment
}

function npmCommand(args) {
  const execpath = process.env.npm_execpath
  if (execpath && /\.[cm]?js$/i.test(execpath)) {
    return { command: process.execPath, args: [execpath, ...args] }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args }
}

async function runNpm(args, cwd) {
  const { command, args: fullArgs } = npmCommand(args)
  return run(command, fullArgs, { cwd, env: npmInstallEnvironment() })
}

async function removeStagingDirectories(parent, prefix) {
  let entries = []
  try { entries = await readdir(parent, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const target = path.join(parent, entry.name)
    assertChild(parent, target)
    await rm(target, { recursive: true, force: true })
  }
}

function directorySize(target) {
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    const metadata = lstatSync(child)
    if (metadata.isSymbolicLink()) continue
    if (metadata.isDirectory()) total += directorySize(child)
    else total += metadata.size
  }
  return total
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

async function download(url, destination) {
  const partial = `${destination}.${process.pid}.partial`
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  const handle = await open(partial, 'w')
  try {
    for await (const chunk of response.body) await handle.write(chunk)
  } finally {
    await handle.close()
  }
  await rename(partial, destination)
}

/**
 * 解压 zip：优先 Windows 10+ 自带的 bsdtar（System32\tar.exe，zip/tar 通吃），
 * 不能用 PATH 上裸的 tar——开发机 PATH 常被 Git Bash 的 GNU tar 抢占，
 * GNU tar 读不了 zip 还把 "C:" 前缀当远程主机名。兜底 Expand-Archive。
 */
async function extractZip(archive, destination) {
  const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (process.platform === 'win32' && existsSync(bsdtar)) {
    await run(bsdtar, ['-xf', path.basename(archive)], { cwd: destination })
    return
  }
  if (process.platform === 'win32') {
    const script = 'Expand-Archive -LiteralPath $env:UDSH_ARCHIVE -DestinationPath $env:UDSH_DESTINATION -Force'
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, UDSH_ARCHIVE: archive, UDSH_DESTINATION: destination },
    })
    return
  }
  await run('tar', ['-xf', archive, '-C', destination])
}

// ---------------------------------------------------------------------------
// vendor/runtime/win32-x64 —— Node 运行时
// ---------------------------------------------------------------------------

async function runtimeStamp() {
  try { return JSON.parse(await readFile(runtimeStampFile, 'utf8')) } catch { return null }
}

async function runtimeIsCurrent() {
  const stamp = await runtimeStamp()
  return Boolean(stamp?.nodeVersion === channel.node.version
    && existsSync(path.join(runtimeDir, 'node.exe')))
}

async function prepareRuntime() {
  if (!forceMode && await runtimeIsCurrent()) {
    log(`Node ${channel.node.version} 运行时已就绪，跳过（--force 可强制重做）`)
    return
  }
  const runtimeParent = path.join(vendorDir, 'runtime')
  await removeStagingDirectories(vendorDir, '.runtime-staging-')
  const staging = path.join(vendorDir, `.runtime-staging-${process.pid}`)
  assertChild(vendorDir, staging)
  await mkdir(staging, { recursive: true })
  try {
    const archive = path.join(staging, channel.node.archive)
    log(`下载 ${channel.node.url}`)
    await download(channel.node.url, archive)
    const digest = await sha256(archive)
    if (digest !== channel.node.sha256) {
      throw new Error(`Node 压缩包 SHA-256 校验失败：期望 ${channel.node.sha256}，实际 ${digest}`)
    }
    log('SHA-256 校验通过，解压中…')
    await extractZip(archive, staging)
    const extracted = path.join(staging, channel.node.archive.replace(/\.zip$/i, ''))
    if (!existsSync(path.join(extracted, 'node.exe'))) {
      throw new Error('Node 压缩包结构校验失败：缺少 node.exe')
    }
    // include/ 只在编译原生模块时用得上，随包运行时永远不编译，删掉省体积。
    await rm(path.join(extracted, 'include'), { recursive: true, force: true })
    await writeFile(path.join(extracted, path.basename(runtimeStampFile)), `${JSON.stringify({
      schemaVersion: 1,
      nodeVersion: channel.node.version,
      target: runtimeTarget,
      sha256: channel.node.sha256,
    }, null, 2)}\n`)
    await mkdir(runtimeParent, { recursive: true })
    if (existsSync(runtimeDir)) {
      assertChild(vendorDir, runtimeDir)
      await rm(runtimeDir, { recursive: true, force: true })
    }
    await rename(extracted, runtimeDir)
    log(`Node ${channel.node.version} 运行时就绪：${megabytes(directorySize(runtimeDir))}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// vendor/harness —— DSH 依赖闭包
// ---------------------------------------------------------------------------

async function officialMetadata() {
  const encodedName = encodeURIComponent(channel.dsh.package).replace('%40', '@')
  const url = `${channel.dsh.registry.replace(/\/$/, '')}/${encodedName}`
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`读取官方 registry 元数据失败：HTTP ${response.status}`)
  return response.json()
}

const SHARED_INSTALL_FLAGS = [
  '--no-audit',
  '--no-fund',
  '--legacy-peer-deps',
  '--maxsockets=6',
  '--fetch-retries=2',
  '--fetch-timeout=60000',
]

/**
 * 在 staging 目录里装出 DSH 闭包。参数沿用运行期 installDsh 已调通的那套
 * （--legacy-peer-deps、--before 时间窗、多轮 peer 收敛），只去掉了
 * --prefer-offline：构建机没必要，也怀疑是客户机装坏的诱因之一。
 */
async function installHarness(staging, version, publishedAt) {
  // npm 的 prerelease caret 会把 rc.7 的内部包解析到 rc.8；限制到该版本发布时间窗口。
  const before = new Date(new Date(publishedAt).getTime() + 10 * 60_000).toISOString()
  const installRegistries = channel.dsh.installRegistries?.length
    ? channel.dsh.installRegistries
    : [channel.dsh.registry]
  let installError
  for (const registry of installRegistries) {
    await rm(path.join(staging, 'node_modules'), { recursive: true, force: true })
    await rm(path.join(staging, 'package-lock.json'), { force: true })
    log(`npm install ${channel.dsh.package}@${version}（registry ${registry}）`)
    try {
      await runNpm(['install', ...SHARED_INSTALL_FLAGS, `--before=${before}`, `--registry=${registry}`], staging)
      // DSH 的内部包靠 peerDependencies 互相发现且确实需要多轮收敛：
      // 查的是 node_modules 下所有顶层包的 peer 声明，不是根包的（根包声明 0 个）。
      for (let round = 0; round < 5; round += 1) {
        const missingPeers = await missingRequiredPeers(staging, version)
        if (missingPeers.length === 0) break
        log(`补齐 ${missingPeers.length} 个 peer 依赖（第 ${round + 1} 轮）`)
        await runNpm([
          'install',
          '--save-exact',
          ...SHARED_INSTALL_FLAGS,
          `--before=${before}`,
          `--registry=${registry}`,
          ...missingPeers.map(({ name, spec }) => `${name}@${spec}`),
        ], staging)
      }
      const unresolvedPeers = await missingRequiredPeers(staging, version)
      if (unresolvedPeers.length > 0) {
        throw new Error(`DSH peer 依赖未收敛：${unresolvedPeers.map(({ name }) => name).join(', ')}`)
      }
      return
    } catch (error) {
      installError = error
      log(`registry ${registry} 安装失败：${error.message}`)
    }
  }
  throw installError
}

/** 把 node_modules 下所有 symlink/junction 换成解引用的真实拷贝；
 *  .bin 目录整个删掉（子进程直接用 node 跑入口，不走 shim）。 */
function materializeStagedLinks(harnessRoot) {
  const nodeModules = path.join(harnessRoot, 'node_modules')
  for (;;) {
    const link = findSymlinkOrBin(nodeModules)
    if (link === undefined) break
    if (path.basename(link) === '.bin') {
      rmSync(link, { recursive: true, force: true })
      continue
    }
    const source = realpathSync(link)
    rmSync(link, { recursive: true, force: true })
    cpSync(source, link, { recursive: true, dereference: true })
  }
}

function findSymlinkOrBin(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.name === '.bin') return target
    const metadata = lstatSync(target)
    if (metadata.isSymbolicLink()) return target
    if (metadata.isDirectory()) {
      const nested = findSymlinkOrBin(target)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** node-pty 的 prebuilds 带了所有平台的二进制，只留 win32-x64。 */
function pruneHarness(harnessRoot) {
  const prebuilds = path.join(harnessRoot, 'node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (entry === runtimeTarget) continue
      rmSync(path.join(prebuilds, entry), { recursive: true, force: true })
    }
  }

  // sharp 会把所有平台的原生变体都装下来。Windows 包只走 @img/sharp-win32-x64，
  // wasm32 变体（8.7MB）纯属白背 —— 而且它是 LGPL-3.0-or-later，
  // 少一个 copyleft 组件就少一份合规负担。
  // 实测依据：剪掉后用随包 Node 跑 `require('sharp')` 并真做一次 png 编码，均通过。
  // win32-x64 剪不掉：dsh-attachment-local 是静态 `from "sharp"`，删了图片附件就废。
  const img = path.join(harnessRoot, 'node_modules', '@img')
  if (existsSync(img)) {
    for (const entry of readdirSync(img)) {
      if (!entry.startsWith('sharp-')) continue
      if (entry === `sharp-${runtimeTarget}`) continue
      rmSync(path.join(img, entry), { recursive: true, force: true })
    }
  }
}

/** 构建期把 Windows 打开路径的 -EncodedCommand 补丁施加到闭包里的 apiproxy。 */
function patchHarnessApiProxy(harnessRoot) {
  const target = path.join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js')
  if (!existsSync(target)) {
    throw new Error(`闭包里找不到 dsh-host-apiproxy：${target}（上游依赖结构变了，请复核补丁是否还需要）`)
  }
  const changed = prepareApiProxy(target)
  log(`dsh-host-apiproxy Windows 打开路径补丁${changed ? '已施加' : '已存在'}`)
}

async function prepareHarness() {
  const version = channel.dsh.version
  if (!forceMode) {
    try {
      await validateDshAt(harnessDir, channel.dsh.package, version, null)
      log(`DSH ${version} 闭包已就绪，跳过（--force 可强制重做）`)
      return
    } catch { /* 不存在或不完整，重新生成。 */ }
  }

  const metadata = await officialMetadata()
  const publishedAt = metadata?.time?.[version]
  const officialIntegrity = metadata?.versions?.[version]?.dist?.integrity
  if (!metadata?.versions?.[version] || !publishedAt) throw new Error(`官方 npm 中不存在 DSH ${version}`)
  if (!officialIntegrity) throw new Error(`官方 npm 没有 DSH ${version} 的完整性摘要`)

  await removeStagingDirectories(vendorDir, '.harness-staging-')
  const staging = path.join(vendorDir, `.harness-staging-${process.pid}`)
  assertChild(vendorDir, staging)
  await mkdir(staging, { recursive: true })
  try {
    await writeFile(path.join(staging, 'package.json'), `${JSON.stringify({
      name: 'u-dsh-vendored-kernel',
      version: '0.0.0',
      private: true,
      dependencies: { [channel.dsh.package]: version },
    }, null, 2)}\n`)
    await installHarness(staging, version, publishedAt)
    // 校验：包身份/版本、bin 入口不越界、根包 integrity 与官方元数据一致、peer 收敛。
    await validateDshAt(staging, channel.dsh.package, version, null, officialIntegrity)

    const before = directorySize(staging)
    materializeStagedLinks(staging)
    pruneHarness(staging)
    patchHarnessApiProxy(staging)
    const after = directorySize(staging)
    log(`闭包剪枝：${megabytes(before)} → ${megabytes(after)}`)

    // 后处理之后再整体校验一遍，确保剪枝没有破坏闭包。
    await validateDshAt(staging, channel.dsh.package, version, null, officialIntegrity)

    if (existsSync(harnessDir)) {
      assertChild(vendorDir, harnessDir)
      await rm(harnessDir, { recursive: true, force: true })
    }
    await rename(staging, harnessDir)
    log(`DSH ${version} 闭包就绪：${harnessDir}`)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

// ---------------------------------------------------------------------------
// --check —— 不联网的产物门禁（dist 链在打包前必须过）
// ---------------------------------------------------------------------------

async function check() {
  const problems = []
  if (!(await runtimeIsCurrent())) {
    const stamp = await runtimeStamp()
    problems.push(`vendor/runtime/${runtimeTarget} 缺失或版本不符：期望 Node ${channel.node.version}，实际 ${stamp?.nodeVersion ?? '（无）'}`)
  }
  try {
    await validateDshAt(harnessDir, channel.dsh.package, channel.dsh.version, null)
  } catch (error) {
    problems.push(`vendor/harness 校验失败：${error.message}`)
  }
  if (problems.length > 0) {
    for (const problem of problems) fail(problem)
    fail('先运行 npm run prepare:vendor 生成随包内核，再打包。')
    return
  }
  log(`--check 通过：Node ${channel.node.version} + DSH ${channel.dsh.version}（runtime ${megabytes(directorySize(runtimeDir))}，harness ${megabytes(directorySize(harnessDir))}）`)
}

if (checkMode) {
  await check()
} else {
  await prepareRuntime()
  await prepareHarness()
}
