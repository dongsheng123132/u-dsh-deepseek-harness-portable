import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createTrayMenuTemplate, shouldHideWindowOnClose } from '../src/window-lifecycle.js'

test('window close hides the app unless it is quitting', () => {
  assert.equal(shouldHideWindowOnClose(false), true)
  assert.equal(shouldHideWindowOnClose(true), false)
  assert.equal(shouldHideWindowOnClose(false, false), false)
})

test('tray menu exposes main window, wallet, hide, and quit actions', () => {
  const actions = []
  const menu = createTrayMenuTemplate({
    locale: 'zh-CN',
    showWindow: () => actions.push('show'),
    openWallet: () => actions.push('wallet'),
    hideWindow: () => actions.push('hide'),
    quit: () => actions.push('quit'),
  })

  assert.deepEqual(menu.map(({ label, type }) => label ?? type), [
    '打开 U-DSH',
    '设备钱包',
    '隐藏窗口',
    'separator',
    '退出',
  ])

  menu[0].click()
  menu[1].click()
  menu[2].click()
  menu[4].click()
  assert.deepEqual(actions, ['show', 'wallet', 'hide', 'quit'])
})

test('tray menu falls back to English labels', () => {
  const menu = createTrayMenuTemplate({
    locale: 'en-US',
    showWindow() {},
    openWallet() {},
    hideWindow() {},
    quit() {},
  })

  assert.deepEqual(menu.map(({ label, type }) => label ?? type), [
    'Open U-DSH',
    'Device Wallet',
    'Hide Window',
    'separator',
    'Quit',
  ])
})

test('startup screen exposes a live first-run kernel status', async () => {
  const html = await readFile(new URL('../src/startup.html', import.meta.url), 'utf8')

  assert.match(html, /trayTemplate@2x\.png/)
  assert.match(html, /class="progress"/)
  assert.match(html, /id="status"/)
  assert.match(html, /window\.udshSetStatus/)
  assert.doesNotMatch(html, /<h1/)
})
