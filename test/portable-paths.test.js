import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { resolvePortablePaths } from '../src/portable-paths.js'

// 这条用例断言的是 **win32 的路径语义**：src/portable-paths.js 用宿主机的
// `node:path` 解析，于是 macOS / Linux 上 `path.resolve('I:\\U-DSH', ...)` 会按 posix
// 规则加上 cwd 前缀，Windows 风格路径不可能对得上。
//
// 这不是「藏失败」：Windows CI（ci.yml 的 windows-latest）仍然跑这条用例、仍然守着它的语义。
// 这里显式 skip 并打印原因，macOS job 才能作为真正的回归闸门上线。
// 另一条路是让源码在 platform==='win32' 时改用 path.win32 —— 那要动产品路径逻辑，不在本次范围。
const skipOnNonWindows =
  process.platform === 'win32'
    ? false
    : `win32-only assertion: host path module is posix on ${process.platform} (covered by the Windows CI job)`

test('portable paths keep durable data on the USB root and runtime cache on the host', { skip: skipOnNonWindows }, () => {
  const paths = resolvePortablePaths({
    env: {
      UDSH_PORTABLE_ROOT: 'I:\\U-DSH',
      UDSH_HOST_ROOT: 'C:\\Users\\test\\AppData\\Local\\U-DSH',
    },
    platform: 'win32',
    isPackaged: true,
  })

  assert.equal(paths.dshHome, path.join('I:\\U-DSH', 'data', 'dsh-home'))
  assert.equal(paths.walletFile, path.join('I:\\U-DSH', 'data', 'u-dsh-state', 'device-wallet.json'))
  assert.equal(paths.electronDataDir, path.join('C:\\Users\\test\\AppData\\Local\\U-DSH', 'electron'))
  assert.equal(paths.activeKernelFile, path.join('C:\\Users\\test\\AppData\\Local\\U-DSH', 'kernel', 'active.json'))
  // 内核已随包 vendor：不再有下载/版本/npm 缓存目录。
  assert.equal(paths.downloadsDir, undefined)
  assert.equal(paths.nodeVersionsDir, undefined)
  assert.equal(paths.dshVersionsDir, undefined)
  assert.equal(paths.npmCacheDir, undefined)
})

test('development paths are isolated below .u-dsh-dev', () => {
  const paths = resolvePortablePaths({ env: {}, cwd: 'C:\\work\\u-dsh', platform: 'win32' })
  assert.equal(paths.portableRoot, path.join('C:\\work\\u-dsh', '.u-dsh-dev', 'portable'))
  assert.equal(paths.hostRoot, path.join('C:\\work\\u-dsh', '.u-dsh-dev', 'host'))
})

test('a portable CLI override still sends caches to LOCALAPPDATA', () => {
  const paths = resolvePortablePaths({
    env: {
      UDSH_PORTABLE_ROOT: 'I:\\U-DSH',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    },
    cwd: 'D:\\unrelated-working-directory',
    platform: 'win32',
  })
  assert.equal(paths.portableRoot, path.resolve('I:\\U-DSH'))
  assert.equal(paths.hostRoot, path.join('C:\\Users\\tester\\AppData\\Local', 'U-DSH'))
})
