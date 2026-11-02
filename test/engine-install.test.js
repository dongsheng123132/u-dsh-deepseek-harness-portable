import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('pickMode: auto 默认装本机（不按盘容量猜）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-auto-'))
  try {
    const appRoot = await createApp(root)
    // 回归：曾经按「盘 ≥128GB → drive」判断，导致大容量本地盘/U 盘把引擎塞回便携包
    assert.equal(pickMode(appRoot, 'auto'), 'host')
    assert.equal(pickMode(appRoot, undefined), 'host')
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

/** 造一个「单文件归档」形态的包：appRoot/engine.tar 里放 runtime + 闭包 + package.json。 */
async function createTarballApp(root) {
  const appRoot = await createApp(root)
  const staging = path.join(root, 'tar-staging')
  await cp(path.join(appRoot, 'runtime'), path.join(staging, 'runtime'), { recursive: true })
  await cp(path.join(appRoot, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true })
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'u-dsh-vendored-kernel', version: '0.0.0' }))
  execFileSync('tar', ['-cf', path.join(appRoot, 'engine.tar'), '-C', staging, 'runtime', 'node_modules', 'package.json'])
  // 归档形态下随包不再有松散目录
  await rm(path.join(appRoot, 'runtime'), { recursive: true, force: true })
  await rm(path.join(appRoot, 'node_modules'), { recursive: true, force: true })
  await rm(staging, { recursive: true, force: true })
  // 版本号仍然要能从归档外读到；真实包里由 launcher 侧 package.json 提供版本时不影响。
  const pkgDir = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }))
  return appRoot
}

test('resolveEngine engine.tar: 单文件归档也能装本机、可复用、usb 退化成 temp', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'udsh-engine-tar-'))
  const hostRoot = path.join(root, 'host-engine')
  try {
    const appRoot = await createTarballApp(root)
    const first = await withEnv({ UDSH_ENGINE_HOST_ROOT: hostRoot }, () => resolveEngine({ appRoot, mode: 'host' }))
    assert.equal(first.mode, 'host')
    assert.equal(first.engineRoot, path.join(hostRoot, VERSION))
    const manifest = JSON.parse(await readFile(path.join(first.engineRoot, 'engine-manifest.json'), 'utf8'))
    assert.equal(manifest.source, 'engine.tar')
    assert.ok(await readFile(path.join(first.engineRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8').then(Boolean))

    const second = await withEnv({ UDSH_ENGINE_HOST_ROOT: hostRoot }, () => resolveEngine({ appRoot, mode: 'host' }))
    assert.equal(second.engineRoot, first.engineRoot)

    const usb = await withEnv({ UDSH_ENGINE_HOST_ROOT: hostRoot }, () => resolveEngine({ appRoot, mode: 'usb' }))
    assert.equal(usb.mode, 'temp', 'usb 模式在归档形态下应退化成 temp')
  } finally { await rm(root, { recursive: true, force: true }) }
})
