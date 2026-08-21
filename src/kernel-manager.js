import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { writeTextAtomic } from './atomic-file.js'

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function assertChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作内核目录之外的路径：${candidate}`)
  }
}

function parseVersion(value) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function supportedNodeVersion(version, channel) {
  const actual = parseVersion(version)
  const minimum = parseVersion(channel.node.minimumVersion || '22.12.0')
  return Boolean(actual && minimum && compareVersions(actual, minimum) >= 0)
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))]
}

function systemNodeCandidates({ env, platform }) {
  const delimiter = platform === 'win32' ? ';' : path.delimiter
  const entries = String(env.PATH || '').split(delimiter).filter(Boolean)
  const candidates = []
  if (env.UDSH_NODE_EXECUTABLE?.trim()) candidates.push(env.UDSH_NODE_EXECUTABLE.trim())
  for (const entry of entries) candidates.push(path.join(entry, platform === 'win32' ? 'node.exe' : 'node'))
  if (platform === 'win32') {
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'nodejs', 'node.exe'))
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'nvm', 'node.exe'))
      candidates.push(path.join(env.LOCALAPPDATA, 'nvm', 'current', 'node.exe'))
    }
    // U-King/U-Claw installs a shared Node runtime here.  It is a valid
    // system runtime for U-DSH and must be reused before downloading the
    // pinned portable archive again.
    if (env.USERPROFILE) {
      candidates.push(path.join(env.USERPROFILE, '.uking', 'runtime', 'node', 'node.exe'))
    }
  }
  return unique(candidates)
}

async function discoverSystemNode({ env, platform, channel, runner }) {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return null
  for (const executable of systemNodeCandidates({ env, platform })) {
    if (!existsSync(executable)) continue
    try {
      const result = await runner(executable, ['--version'], { timeoutMs: 5_000 })
      const version = parseVersion(result.stdout)?.join('.')
      if (!supportedNodeVersion(version, channel)) continue
      const nodeDir = path.dirname(executable)
      const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      return {
        nodeExecutable: executable,
        npmCli: existsSync(npmCli) ? npmCli : null,
        version,
        source: 'system',
        reused: true,
      }
    } catch {
      // PATH 里可能残留已卸载的 Node，继续探测下一个候选。
    }
  }
  return null
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
  let lastReportedPercent = -1
  const handle = await open(partial, 'w')
  let failure
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk)
      received += chunk.byteLength
      const percent = total > 0 ? Math.floor(received / total * 100) : -1
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent
        onProgress({ phase: 'downloading-node', received, total })
      }
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

function run(command, args, { timeoutMs = 8 * 60_000, ...options } = {}) {
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
      else finish(reject, new Error(`${path.basename(command)} 退出码 ${code ?? 'unknown'}：${stderr.slice(-1200)}`))
    })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`${path.basename(command)} 超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成`))
    }, timeoutMs)
  })
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

async function topLevelPackageManifests(root) {
  const nodeModules = path.join(root, 'node_modules')
  const manifests = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(nodeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory() && !child.name.startsWith('.')) {
          manifests.push(path.join(nodeModules, entry.name, child.name, 'package.json'))
        }
      }
    } else {
      manifests.push(path.join(nodeModules, entry.name, 'package.json'))
    }
  }
  return manifests
}

async function missingRequiredPeers(root, dshVersion) {
  const missing = new Map()
  for (const manifestPath of await topLevelPackageManifests(root)) {
    let manifest
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { continue }
    const requireFromPackage = createRequire(manifestPath)
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) continue
      try {
        requireFromPackage.resolve(name)
      } catch {
        const spec = name.startsWith('@deepseek-ai/dsh-') ? dshVersion : range
        missing.set(name, spec)
      }
    }
  }
  return [...missing].map(([name, spec]) => ({ name, spec }))
}

async function expandZipWindows(archive, destination, runner) {
  const script = 'Expand-Archive -LiteralPath $env:UDSH_ARCHIVE -DestinationPath $env:UDSH_DESTINATION -Force'
  await runner('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, UDSH_ARCHIVE: archive, UDSH_DESTINATION: destination },
  })
}

async function validateDshAt(root, packageName, version, nodeExecutable, expectedIntegrity) {
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
  if (expectedIntegrity) {
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
    const actualIntegrity = lock.packages?.[`node_modules/${packageName}`]?.integrity
    if (actualIntegrity !== expectedIntegrity) {
      throw new Error('DSH 根包完整性与官方 registry 元数据不一致')
    }
  }
  const missingPeers = await missingRequiredPeers(root, version)
  if (missingPeers.length > 0) {
    throw new Error(`DSH 缺少必需的 peer 依赖：${missingPeers.map(({ name }) => name).join(', ')}`)
  }
  return { version, root, entry, source: 'installed', nodeExecutable }
}

/**
 * 来自社区桌面壳的共同做法：壳不修改 DSH，把官方包安装在版本目录中。
 * U-DSH 追加了临时目录、身份校验、原子激活和旧版本保留。
 */
export function createKernelManager({
  paths,
  channel,
  fetchImpl = fetch,
  runner = run,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!paths || !channel) throw new Error('paths 和 channel 是必填项')

  const nodeRoot = path.join(paths.nodeVersionsDir, `v${channel.node.version}-${channel.node.platform}`)
  const nodeExecutable = path.join(nodeRoot, 'node.exe')
  const npmCli = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  let resolvedNodeRuntime

  function dshRoot(version) {
    if (!EXACT_VERSION.test(version)) throw new Error(`DSH 版本无效：${version}`)
    return path.join(paths.dshVersionsDir, version)
  }

  function resolveDsh(version) {
    return validateDshAt(dshRoot(version), channel.dsh.package, version, nodeExecutable)
  }

  async function discoverSystemDsh(node) {
    const packageName = channel.dsh.package
    const packageCandidates = []
    if (env.UDSH_DSH_PACKAGE_ROOT?.trim()) packageCandidates.push(env.UDSH_DSH_PACKAGE_ROOT.trim())
    const nodeDir = path.dirname(node.nodeExecutable)
    packageCandidates.push(path.join(nodeDir, 'node_modules', ...packageName.split('/')))
    const delimiter = platform === 'win32' ? ';' : path.delimiter
    for (const entry of String(env.PATH || '').split(delimiter).filter(Boolean)) {
      packageCandidates.push(path.join(entry, 'node_modules', ...packageName.split('/')))
    }
    if (env.NPM_CONFIG_PREFIX?.trim()) {
      packageCandidates.push(path.join(env.NPM_CONFIG_PREFIX.trim(), 'node_modules', ...packageName.split('/')))
    }
    if (env.APPDATA?.trim()) {
      packageCandidates.push(path.join(env.APPDATA.trim(), 'npm', 'node_modules', ...packageName.split('/')))
    }
    for (const packageRoot of unique(packageCandidates)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
        if (manifest.name !== packageName || manifest.version !== channel.dsh.version) continue
        const globalRoot = path.dirname(path.dirname(path.dirname(packageRoot)))
        return await validateDshAt(globalRoot, packageName, channel.dsh.version, node.nodeExecutable)
      } catch {
        // 候选目录不存在、版本不对或依赖不完整，继续走下一个候选。
      }
    }
    return null
  }

  async function ensureNode(onProgress = () => {}) {
    if (resolvedNodeRuntime) return resolvedNodeRuntime
    if (existsSync(nodeExecutable) && existsSync(npmCli)) {
      resolvedNodeRuntime = { nodeExecutable, npmCli, reused: true, source: 'portable' }
      return resolvedNodeRuntime
    }
    const system = await discoverSystemNode({ env, platform, channel, runner })
    if (system) {
      resolvedNodeRuntime = system
      return resolvedNodeRuntime
    }
    if (platform !== 'win32' || process.arch !== 'x64') {
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

    await removeStagingDirectories(paths.nodeVersionsDir, `.install-v${channel.node.version}-`)
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
    resolvedNodeRuntime = { nodeExecutable, npmCli, reused: false, source: 'downloaded' }
    return resolvedNodeRuntime
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
    const systemDsh = await discoverSystemDsh(node)
    if (systemDsh) return systemDsh
    const metadata = await registryMetadata()
    const publishedAt = metadata?.time?.[version]
    if (!metadata?.versions?.[version] || !publishedAt) throw new Error(`官方 npm 中不存在 DSH ${version}`)

    await removeStagingDirectories(paths.dshVersionsDir, `.install-${version}-`)
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
      const installRegistries = channel.dsh.installRegistries?.length
        ? channel.dsh.installRegistries
        : [channel.dsh.registry]
      let installError
      for (const registry of installRegistries) {
        await rm(path.join(staging, 'node_modules'), { recursive: true, force: true })
        await rm(path.join(staging, 'package-lock.json'), { force: true })
        onProgress({ phase: 'installing-dsh', version, registry })
        try {
          await runner(node.nodeExecutable, [
            node.npmCli,
            'install',
            '--no-audit',
            '--no-fund',
            '--prefer-offline',
            '--legacy-peer-deps',
            '--maxsockets=6',
            '--fetch-retries=2',
            '--fetch-timeout=60000',
            `--before=${before}`,
            `--registry=${registry}`,
          ], {
            cwd: staging,
            timeoutMs: 4 * 60_000,
            env: {
              ...process.env,
              npm_config_cache: paths.npmCacheDir,
              npm_config_update_notifier: 'false',
            },
          })
          for (let round = 0; round < 5; round += 1) {
            const missingPeers = await missingRequiredPeers(staging, version)
            if (missingPeers.length === 0) break
            onProgress({
              phase: 'installing-dsh-peers',
              version,
              count: missingPeers.length,
              round: round + 1,
            })
            await runner(node.nodeExecutable, [
              node.npmCli,
              'install',
              '--no-audit',
              '--no-fund',
              '--save-exact',
              '--prefer-offline',
              '--legacy-peer-deps',
              '--maxsockets=6',
              '--fetch-retries=2',
              '--fetch-timeout=60000',
              `--before=${before}`,
              `--registry=${registry}`,
              ...missingPeers.map(({ name, spec }) => `${name}@${spec}`),
            ], {
              cwd: staging,
              timeoutMs: 4 * 60_000,
              env: {
                ...process.env,
                npm_config_cache: paths.npmCacheDir,
                npm_config_update_notifier: 'false',
              },
            })
          }
          const unresolvedPeers = await missingRequiredPeers(staging, version)
          if (unresolvedPeers.length > 0) {
            throw new Error(`DSH peer 依赖未收敛：${unresolvedPeers.map(({ name }) => name).join(', ')}`)
          }
          installError = null
          break
        } catch (error) {
          installError = error
        }
      }
      if (installError) throw installError
      const officialIntegrity = metadata.versions[version]?.dist?.integrity
      if (!officialIntegrity) throw new Error(`官方 npm 没有 DSH ${version} 的完整性摘要`)
      await validateDshAt(staging, channel.dsh.package, version, nodeExecutable, officialIntegrity)
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
    const system = await discoverSystemNode({ env, platform, channel, runner })
    return {
      nodeVersion: system?.version || channel.node.version,
      nodeReady: Boolean(system || (existsSync(nodeExecutable) && existsSync(npmCli))),
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
