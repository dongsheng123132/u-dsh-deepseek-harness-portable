import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {
  buildDshCommand,
  buildDshArgs,
  extractReadyUrl,
  resolveWindowsHiddenConsoleLauncher,
  resolveWindowsPickerPatch,
  unpackedPath,
} from '../src/dsh-service.js'

test('extractReadyUrl reads the canonical loopback readiness URL', () => {
  assert.equal(
    extractReadyUrl('booting\ndsh web: http://127.0.0.1:60882\n'),
    'http://127.0.0.1:60882',
  )
})

test('extractReadyUrl ignores non-loopback output', () => {
  assert.equal(extractReadyUrl('dsh web: http://192.168.1.10:3080'), undefined)
})

test('unpackedPath maps packaged dependencies to Electron unpacked resources', () => {
  assert.equal(
    unpackedPath('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js',
  )
  assert.equal(unpackedPath('/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js'), '/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js')
})

test('buildDshArgs includes the runtime flag required by upstream HMR', () => {
  assert.deepEqual(buildDshArgs('/app/dsh.js', { platform: 'darwin' }), [
    '--expose-internals',
    '/app/dsh.js',
    '--profile',
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ])
})

test('buildDshArgs pins the browse directory picker on Windows', () => {
  assert.deepEqual(buildDshArgs('C:\\app\\dsh.js', {
    platform: 'win32',
    windowsPickerPatch: 'C:\\app\\windows-picker.yml',
  }), [
    '--expose-internals',
    'C:\\app\\dsh.js',
    '--profile',
    'web',
    '--patch',
    'C:\\app\\windows-picker.yml',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ])
  assert.equal(resolveWindowsPickerPatch().endsWith('windows-directory-picker.patch.yml'), true)
})

test('buildDshCommand uses an available hidden-console launcher on Windows', () => {
  assert.deepEqual(buildDshCommand({
    electronExecutable: 'C:\\app\\DeepSeek Harness.exe',
    entry: 'C:\\app\\dsh.js',
    platform: 'win32',
    windowsLauncher: process.execPath,
    nodeExecutable: 'C:\\cache\\node.exe',
  }), {
    command: process.execPath,
    args: [
      'C:\\cache\\node.exe',
      '--expose-internals',
      'C:\\app\\dsh.js',
      '--profile',
      'web',
      '--patch',
      resolveWindowsPickerPatch(),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
  })
})

test('buildDshCommand starts Electron directly on other platforms', () => {
  assert.deepEqual(buildDshCommand({
    electronExecutable: '/app/electron',
    entry: '/app/dsh.js',
    platform: 'linux',
  }), {
    command: '/app/electron',
    args: [
      '--expose-internals',
      '/app/dsh.js',
      '--profile',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
  })
})

test('resolveWindowsHiddenConsoleLauncher points to the packaged launcher', () => {
  assert.equal(
    resolveWindowsHiddenConsoleLauncher().endsWith(path.join('assets', 'windows-hidden-console.exe')),
    true,
  )
})
