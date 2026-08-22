import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * DSH 依赖闭包的校验逻辑，构建期（scripts/prepare-vendor.mjs）和运行期
 * （src/kernel-manager.js）共用同一份实现，避免两份校验各自漂移。
 * 这里只做只读校验：不联网、不写盘、不起子进程。
 */

export async function sha256(filename) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(filename)
      .on('data', (chunk) => hash.update(chunk))
      .once('end', resolve)
      .once('error', reject)
  })
  return hash.digest('hex')
}

export async function topLevelPackageManifests(root) {
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

/**
 * 检查 node_modules 下所有顶层包（不是根包，根包声明 0 个）的必需
 * peerDependencies 是否都能解析到。DSH 的内部包靠 peer 关系互相发现，
 * 少一个就会在启动时才炸，所以装完必须收敛到 0 缺失。
 */
export async function missingRequiredPeers(root, dshVersion) {
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

/**
 * 校验 root 下的闭包确实是期望的 DSH：包身份与版本、CLI 入口存在且
 * 不越出包目录、（可选）根包 integrity 与官方 registry 元数据一致、
 * 必需 peer 依赖全部收敛。
 */
export async function validateDshAt(root, packageName, version, nodeExecutable, expectedIntegrity) {
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'))
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
  return { version, root, entry, source: 'vendored', nodeExecutable }
}
