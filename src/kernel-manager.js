import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeTextAtomic } from './atomic-file.js'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function assertChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作内核目录之外的路径：${candidate}`)
  }
}

async function sha256(filename) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(filename)
      .on('data', (chunk) => hash.update(chunk))
      .once('end', resolve)
      .once('error', reject)
  })
  return hash.digest('hex')
}

async function download(url, destination, { fetchImpl, onProgress }) {
  const partial = `${destination}.${process.pid}.partial`
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const handle = await open(partial, 'w')
  let failure
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk)
      received += chunk.byteLength
      onProgress({ phase: 'downloading-node', received, total })
    }
  } catch (error) {
    failure = error
  } finally {
    await handle.close()
  }
  if (failure) {
    await rm(partial, { force: true })
    throw failure
  }
  await rename(partial, destination)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${path.basename(command)} 退出码 ${code ?? 'unknown'}：${stderr.slice(-1200)}`))
    })
  })
}

async function expandZipWindows(archive, destination, runner) {
  const script = 'Expand-Archive -LiteralPath $env:UDSH_ARCHIVE -DestinationPath $env:UDSH_DESTINATION -Force'
  await runner('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, UDSH_ARCHIVE: archive, UDSH_DESTINATION: destination },
  })
}

async function validateDshAt(root, packageName, version, nodeExecutable) {
  const packageRoot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`DSH 包身份或版本校验失败：期望 ${packageName}@${version}`)
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (!bin) throw new Error('DSH 包没有声明 dsh CLI 入口')
  const entry = path.resolve(packageRoot, bin)
  const relative = path.relative(packageRoot, entry)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(entry)) {
    throw new Error('DSH CLI 入口越界或不存在')
  }
  return { version, root, entry, source: 'installed', nodeExecutable }
}

/**
 * 来自社区桌面壳的共同做法：壳不修改 DSH，把官方包安装在版本目录中。
 * U-DSH 追加了临时目录、身份校验、原子激活和旧版本保留。
 */
export function createKernelManager({ paths, channel, fetchImpl = fetch, runner = run } = {}) {
  if (!paths || !channel) throw new Error('paths 和 channel 是必填项')

  const nodeRoot = path.join(paths.nodeVersionsDir, `v${channel.node.version}-${channel.node.platform}`)
  const nodeExecutable = path.join(nodeRoot, 'node.exe')
  const npmCli = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')

  function dshRoot(version) {
    if (!EXACT_VERSION.test(version)) throw new Error(`DSH 版本无效：${version}`)
    return path.join(paths.dshVersionsDir, version)
  }

  function resolveDsh(version) {
    return validateDshAt(dshRoot(version), channel.dsh.package, version, nodeExecutable)
  }

  async function ensureNode(onProgress = () => {}) {
    if (existsSync(nodeExecutable) && existsSync(npmCli)) return { nodeExecutable, npmCli, reused: true }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('当前首版内核引导仅支持 Windows x64')
    }

    const archive = path.join(paths.downloadsDir, channel.node.archive)
    await mkdir(paths.downloadsDir, { recursive: true })
    if (!existsSync(archive) || await sha256(archive) !== channel.node.sha256) {
      await rm(archive, { force: true })
      await download(channel.node.url, archive, { fetchImpl, onProgress })
    }
    if (await sha256(archive) !== channel.node.sha256) {
      await rm(archive, { force: true })
      throw new Error('Node 下载包 SHA-256 校验失败')
    }

    const staging = path.join(paths.nodeVersionsDir, `.install-v${channel.node.version}-${Date.now()}`)
    assertChild(paths.nodeVersionsDir, staging)
    await mkdir(staging, { recursive: true })
    try {
      onProgress({ phase: 'extracting-node' })
      await expandZipWindows(archive, staging, runner)
      const extracted = path.join(staging, channel.node.archive.replace(/\.zip$/i, ''))
      if (!existsSync(path.join(extracted, 'node.exe')) || !existsSync(path.join(extracted, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
        throw new Error('Node 压缩包结构校验失败')
      }
      if (existsSync(nodeRoot)) {
        assertChild(paths.nodeVersionsDir, nodeRoot)
        await rm(nodeRoot, { recursive: true, force: true })
      }
      await rename(extracted, nodeRoot)
    } finally {
      if (existsSync(staging)) await rm(staging, { recursive: true, force: true })
    }
    return { nodeExecutable, npmCli, reused: false }
  }

  async function registryMetadata() {
    const encodedName = encodeURIComponent(channel.dsh.package).replace('%40', '@')
    const url = `${channel.dsh.registry.replace(/\/$/, '')}/${encodedName}`
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`读取 DSH 版本目录失败：HTTP ${response.status}`)
    return response.json()
  }

  async function listInstalled() {
    let names = []
    try { names = await readdir(paths.dshVersionsDir) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const valid = []
    for (const version of names.filter((name) => EXACT_VERSION.test(name))) {
      try { valid.push(await resolveDsh(version)) } catch { /* 忽略中断或损坏的目录。 */ }
    }
    return valid
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

  async function installDsh(version, onProgress = () => {}) {
    if (!EXACT_VERSION.test(version)) throw new Error(`DSH 版本无效：${version}`)
    try { return await resolveDsh(version) } catch { /* 未安装或不完整，继续安装。 */ }

    const node = await ensureNode(onProgress)
    const metadata = await registryMetadata()
    const publishedAt = metadata?.time?.[version]
    if (!metadata?.versions?.[version] || !publishedAt) throw new Error(`官方 npm 中不存在 DSH ${version}`)

    const staging = path.join(paths.dshVersionsDir, `.install-${version}-${Date.now()}`)
    assertChild(paths.dshVersionsDir, staging)
    await mkdir(staging, { recursive: true })
    try {
      await writeFile(path.join(staging, 'package.json'), `${JSON.stringify({
        name: 'u-dsh-managed-kernel',
        version: '0.0.0',
        private: true,
        dependencies: { [channel.dsh.package]: version },
      }, null, 2)}\n`)
      // npm 的 prerelease caret 会把 rc.7 的内部包解析到 rc.8；限制到该版本发布时间窗口。
      const before = new Date(new Date(publishedAt).getTime() + 10 * 60_000).toISOString()
      onProgress({ phase: 'installing-dsh', version })
      await runner(node.nodeExecutable, [
        node.npmCli,
        'install',
        '--no-audit',
        '--no-fund',
        '--prefer-online',
        `--before=${before}`,
        `--registry=${channel.dsh.registry}`,
      ], {
        cwd: staging,
        env: {
          ...process.env,
          npm_config_cache: paths.npmCacheDir,
          npm_config_update_notifier: 'false',
        },
      })
      await validateDshAt(staging, channel.dsh.package, version, nodeExecutable)
      const destination = dshRoot(version)
      if (existsSync(destination)) {
        assertChild(paths.dshVersionsDir, destination)
        await rm(destination, { recursive: true, force: true })
      }
      await rename(staging, destination)
      return resolveDsh(version)
    } catch (error) {
      if (existsSync(staging)) await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async function ensure(onProgress = () => {}) {
    await ensureNode(onProgress)
    const previous = await activeVersion()
    const target = await installDsh(channel.dsh.version, onProgress)
    return { target, previous }
  }

  async function checkLatest(tag = 'latest') {
    const metadata = await registryMetadata()
    const version = metadata?.['dist-tags']?.[tag]
    if (!EXACT_VERSION.test(version || '')) throw new Error(`npm 没有可用的 ${tag} 版本标签`)
    return { current: await activeVersion(), pinned: channel.dsh.version, latest: version }
  }

  async function status() {
    const installed = await listInstalled()
    return {
      nodeVersion: channel.node.version,
      nodeReady: existsSync(nodeExecutable) && existsSync(npmCli),
      pinnedVersion: channel.dsh.version,
      activeVersion: await activeVersion(),
      installedVersions: installed.map(({ version }) => version),
      cacheDir: paths.kernelDir,
      dataDir: paths.dshHome,
    }
  }

  return {
    activate,
    activeVersion,
    checkLatest,
    ensure,
    ensureNode,
    installDsh,
    listInstalled,
    resolveDsh,
    status,
  }
}
