import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { resolveEngine, pickMode } = require('../portable-webui/resources/app/engine-install.cjs')

const VERSION = '9.9.9'

async function createApp(root) {
  const appRoot = path.join(root, 'resources', 'app')
  const pkgDir = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(path.join(pkgDir, 'lib'), { recursive: true })
  await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  await writeFile(path.join(pkgDir, 'lib', 'bin.js'), '// fake entry\n')
  const nodeRel = process.platform === 'win32'
    ? path.join('runtime', 'node-win-x64', 'node.exe')
    : path.join('runtime', process.arch === 'arm64' ? 'node-mac-arm64' : 'node-mac-x64', 'bin', 'node')
  await mkdir(path.dirname(path.join(appRoot, nodeRel)), { recursive: true })
  await writeFile(path.join(appRoot, nodeRel), 'fake-node')
  await mkdir(path.join(root, 'data', 'dsh-home'), { recursive: true })
  return appRoot
}

async function withEnv(values, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { return await fn() } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('pickMode: 显式模式优先', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-pick-'))
  try {
    const appRoot = await createApp(root)
    assert.equal(pickMode(appRoot, 'host'), 'host')
    assert.equal(pickMode(appRoot, 'drive'), 'drive')
    assert.equal(pickMode(appRoot, 'temp'), 'temp')
    assert.equal(pickMode(appRoot, 'usb'), 'usb')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('resolveEngine host: 首次安装到本机，数据留在盘上，第二次复用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-host-'))
  const hostRoot = path.join(root, 'host-engine')
  try {
    const appRoot = await createApp(root)
    const first = await withEnv({ UDSH_ENGINE_HOST_ROOT: hostRoot }, () => resolveEngine({ appRoot, mode: 'host' }))
    assert.equal(first.mode, 'host')
    assert.equal(first.engineRoot, path.join(hostRoot, VERSION))
    assert.equal(first.dataRoot, path.join(root, 'data', 'dsh-home'))
    assert.ok(await readFile(path.join(first.engineRoot, 'engine-manifest.json'), 'utf8').then(Boolean))

    const second = await withEnv({ UDSH_ENGINE_HOST_ROOT: hostRoot }, () => resolveEngine({ appRoot, mode: 'host' }))
    assert.equal(second.engineRoot, first.engineRoot)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('resolveEngine usb: 不安装，直接用盘上引擎', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-usb-'))
  try {
    const appRoot = await createApp(root)
    const engine = await withEnv({ UDSH_ENGINE_HOST_ROOT: path.join(root, 'host-engine') }, () => resolveEngine({ appRoot, mode: 'usb' }))
    assert.equal(engine.mode, 'usb')
    assert.equal(engine.engineRoot, appRoot)
    assert.equal(engine.dataRoot, path.join(root, 'data', 'dsh-home'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('resolveEngine drive: 装到盘根 engine/<版本>', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-drive-'))
  try {
    const appRoot = await createApp(root)
    const engine = await withEnv({ UDSH_ENGINE_HOST_ROOT: path.join(root, 'host-engine') }, () => resolveEngine({ appRoot, mode: 'drive' }))
    assert.equal(engine.mode, 'drive')
    assert.equal(engine.engineRoot, path.join(root, 'engine', VERSION))
  } finally { await rm(root, { recursive: true, force: true }) }
})
