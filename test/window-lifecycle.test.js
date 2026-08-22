import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createTrayMenuTemplate, shouldHideWindowOnClose } from '../src/window-lifecycle.js'

test('window close hides the app unless it is quitting', () => {
  assert.equal(shouldHideWindowOnClose(false), true)
  assert.equal(shouldHideWindowOnClose(true), false)
  assert.equal(shouldHideWindowOnClose(false, false), false)
})

test('tray menu exposes main window, wallet, hide, report, and quit actions', () => {
  const actions = []
  const menu = createTrayMenuTemplate({
    locale: 'zh-CN',
    showWindow: () => actions.push('show'),
    openWallet: () => actions.push('wallet'),
    hideWindow: () => actions.push('hide'),
    reportProblem: () => actions.push('report'),
    quit: () => actions.push('quit'),
  })

  assert.deepEqual(menu.map(({ label, type }) => label ?? type), [
    '打开 U-DSH Portable',
    '设备钱包',
    '隐藏窗口',
    'separator',
    '报告问题…',
    'separator',
    '退出',
  ])

  menu[0].click()
  menu[1].click()
  menu[2].click()
  menu[4].click()
  menu[6].click()
  assert.deepEqual(actions, ['show', 'wallet', 'hide', 'report', 'quit'])
})

// 出问题时主界面往往已经不好使，托盘是最后一条还能点的路 —— 这一项不许被挪走。
test('report entry stays reachable from the tray', () => {
  const menu = createTrayMenuTemplate({
    locale: 'zh-CN', showWindow() {}, openWallet() {}, hideWindow() {}, reportProblem() {}, quit() {},
  })
  assert.ok(menu.some(({ label }) => label === '报告问题…'))
})

test('tray menu falls back to English labels', () => {
  const menu = createTrayMenuTemplate({
    locale: 'en-US',
    showWindow() {},
    openWallet() {},
    hideWindow() {},
    reportProblem() {},
    quit() {},
  })

  assert.deepEqual(menu.map(({ label, type }) => label ?? type), [
    'Open U-DSH Portable',
    'Device Wallet',
    'Hide Window',
    'separator',
    'Report a problem…',
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
