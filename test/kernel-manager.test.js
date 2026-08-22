import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createKernelManager, resolveVendorRoot } from '../src/kernel-manager.js'
import { preparePortablePaths, resolvePortablePaths } from '../src/portable-paths.js'

const channel = {
  node: { version: '24.19.0', platform: 'win-x64', archive: 'node.zip', url: 'https://invalid.test/node.zip', sha256: '0'.repeat(64) },
  dsh: { package: '@deepseek-ai/dsh', version: '0.1.0-rc.7', registry: 'https://registry.npmjs.org/' },
}

const throwingFetch = async () => { throw new Error('随包内核绝不允许触网') }

async function createVendorRoot(root, { version = '0.1.0-rc.7', extraManifest = {}, withNode = true } = {}) {
  const vendorRoot = path.join(root, 'vendor')
  const packageRoot = path.join(vendorRoot, 'harness', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' }, ...extraManifest,
  }))
  await writeFile(path.join(packageRoot, 'lib', 'bin.js'), '// fixture\n')
  if (withNode) {
    await mkdir(path.join(vendorRoot, 'runtime', 'win32-x64'), { recursive: true })
    await writeFile(path.join(vendorRoot, 'runtime', 'win32-x64', 'node.exe'), '')
  }
  return vendorRoot
}

async function fixture(options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-kernel-test-'))
  const vendorRoot = await createVendorRoot(root, options)
  const paths = preparePortablePaths(resolvePortablePaths({
    env: {
      UDSH_PORTABLE_ROOT: path.join(root, 'usb'),
      UDSH_HOST_ROOT: path.join(root, 'host'),
    },
  }))
  const manager = createKernelManager({
    paths,
    channel,
    vendorRoot,
    platform: 'win32',
    arch: 'x64',
    fetchImpl: throwingFetch,
  })
  return { root, vendorRoot, paths, manager }
}

test('ensure resolves the vendored kernel locally even when fetch always throws', async () => {
  const { root, vendorRoot, paths, manager } = await fixture()
  try {
    const { target, previous } = await manager.ensure()
    assert.equal(previous, null)
    assert.equal(target.version, '0.1.0-rc.7')
    assert.equal(target.source, 'vendored')
    assert.equal(target.nodeExecutable, path.join(vendorRoot, 'runtime', 'win32-x64', 'node.exe'))
    assert.equal(target.entry, path.join(vendorRoot, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))

    await manager.activate(target.version)
    const status = await manager.status()
    assert.equal(status.nodeReady, true)
    assert.equal(status.activeVersion, '0.1.0-rc.7')
    assert.deepEqual(status.installedVersions, ['0.1.0-rc.7'])
    assert.equal(status.dataDir.startsWith(paths.portableRoot), true)
    assert.equal(status.cacheDir, path.join(vendorRoot, 'harness'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kernel manager refuses a forged package identity', async () => {
  const { root, vendorRoot, manager } = await fixture()
  try {
    const manifest = path.join(vendorRoot, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    await writeFile(manifest, JSON.stringify({ name: 'not-dsh', version: '0.1.0-rc.7', bin: 'lib/bin.js' }))
    await assert.rejects(manager.resolveDsh('0.1.0-rc.7'), /身份或版本校验失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kernel manager refuses a vendored DSH with missing required peers', async () => {
  const { root, manager } = await fixture({
    extraManifest: { peerDependencies: { '@deepseek-ai/dsh-invariants': '^0.1.0-rc.7' } },
  })
  try {
    await assert.rejects(manager.resolveDsh('0.1.0-rc.7'), /缺少必需的 peer 依赖/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kernel manager only serves the pinned version and fails fast without the runtime', async () => {
  const { root, manager } = await fixture({ withNode: false })
  try {
    await assert.rejects(manager.resolveDsh('9.9.9'), /只有固定版本/)
    await assert.rejects(manager.ensure(), /随包 Node 运行时缺失/)
    const status = await manager.status()
    assert.equal(status.nodeReady, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkLatest is non-fatal and reports unknown when the network is down', async () => {
  const { root, manager } = await fixture()
  try {
    const value = await manager.checkLatest()
    assert.deepEqual(value, { current: null, pinned: '0.1.0-rc.7', latest: '' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 决定性回归：随包内核代码路径里不允许存在任何会 spawn npm / 下载 / 解压
// 的实现。文本断言抓的是"有人把安装逻辑加回来"这一类回归。
test('kernel code path contains no npm/download/extract machinery', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  for (const filename of ['kernel-manager.js', 'harness-validate.js']) {
    const source = readFileSync(path.join(srcDir, filename), 'utf8')
    for (const forbidden of ['child_process', 'spawn', 'npm-cli', 'installDsh', 'Expand-Archive', 'downloadsDir', 'npmCacheDir']) {
      assert.equal(source.includes(forbidden), false, `${filename} 不应包含 ${forbidden}`)
    }
  }
})

test('resolveVendorRoot honours UDSH_VENDOR_ROOT and falls back to the repo vendor dir', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-vendor-root-test-'))
  try {
    assert.equal(
      resolveVendorRoot({ env: { UDSH_VENDOR_ROOT: root } }),
      path.resolve(root),
    )
    const repoVendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor')
    const resolved = resolveVendorRoot({ env: {}, resourcesPath: undefined })
    // 打包前 resources 候选不存在 harness，必须回落到仓库 vendor/。
    assert.equal([repoVendor, path.resolve(repoVendor, '..', '..')].includes(resolved), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
