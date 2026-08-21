import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelManager } from '../src/kernel-manager.js'
import { preparePortablePaths, resolvePortablePaths } from '../src/portable-paths.js'

const channel = {
  node: { version: '24.19.0', platform: 'win-x64', archive: 'node.zip', url: 'https://invalid.test/node.zip', sha256: '0'.repeat(64) },
  dsh: { package: '@deepseek-ai/dsh', version: '0.1.0-rc.7', registry: 'https://registry.npmjs.org/' },
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-kernel-test-'))
  const paths = preparePortablePaths(resolvePortablePaths({
    env: {
      UDSH_PORTABLE_ROOT: path.join(root, 'usb'),
      UDSH_HOST_ROOT: path.join(root, 'host'),
    },
  }))
  return { root, paths, manager: createKernelManager({ paths, channel }) }
}

async function createInstalled(paths, version, extraManifest = {}) {
  const packageRoot = path.join(paths.dshVersionsDir, version, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' }, ...extraManifest,
  }))
  await writeFile(path.join(packageRoot, 'lib', 'bin.js'), '// fixture\n')
}

test('kernel activation is a validated pointer and keeps version directories intact', async () => {
  const { root, paths, manager } = await fixture()
  try {
    await createInstalled(paths, '0.1.0-rc.6')
    await createInstalled(paths, '0.1.0-rc.7')
    await manager.activate('0.1.0-rc.6')
    await manager.activate('0.1.0-rc.7')

    const status = await manager.status()
    assert.equal(status.activeVersion, '0.1.0-rc.7')
    assert.deepEqual(status.installedVersions.sort(), ['0.1.0-rc.6', '0.1.0-rc.7'])
    assert.equal(status.dataDir.startsWith(paths.portableRoot), true)
    assert.equal(status.cacheDir.startsWith(paths.hostRoot), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kernel manager refuses a forged package identity', async () => {
  const { root, paths, manager } = await fixture()
  try {
    await createInstalled(paths, '0.1.0-rc.7')
    const manifest = path.join(paths.dshVersionsDir, '0.1.0-rc.7', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    await writeFile(manifest, JSON.stringify({ name: 'not-dsh', version: '0.1.0-rc.7', bin: 'lib/bin.js' }))
    await assert.rejects(manager.resolveDsh('0.1.0-rc.7'), /身份或版本校验失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kernel manager refuses an installed DSH with missing required peers', async () => {
  const { root, paths, manager } = await fixture()
  try {
    await createInstalled(paths, '0.1.0-rc.7', {
      peerDependencies: { '@deepseek-ai/dsh-invariants': '^0.1.0-rc.7' },
    })
    await assert.rejects(manager.resolveDsh('0.1.0-rc.7'), /缺少必需的 peer 依赖/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
