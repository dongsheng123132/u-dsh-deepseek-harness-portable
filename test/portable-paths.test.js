import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { resolvePortablePaths } from '../src/portable-paths.js'

test('portable paths keep durable data on the USB root and runtime cache on the host', () => {
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
  assert.equal(paths.dshVersionsDir, path.join('C:\\Users\\test\\AppData\\Local\\U-DSH', 'kernel', 'dsh'))
})

test('development paths are isolated below .u-dsh-dev', () => {
  const paths = resolvePortablePaths({ env: {}, cwd: 'C:\\work\\u-dsh', platform: 'win32' })
  assert.equal(paths.portableRoot, path.join('C:\\work\\u-dsh', '.u-dsh-dev', 'portable'))
  assert.equal(paths.hostRoot, path.join('C:\\work\\u-dsh', '.u-dsh-dev', 'host'))
})
