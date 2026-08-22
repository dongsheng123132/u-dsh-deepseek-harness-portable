import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WALLET_OPEN_URL, buildWalletEntryScript, isWalletOpenRequest, shouldAutoOpenWallet } from '../src/first-run.js'
import { probeJunctionSupport } from '../src/portable-preflight.js'
import { describeStartupFailure } from '../src/startup-errors.js'

test('udsh:// 被认成钱包请求，普通链接照常外开', () => {
  assert.ok(isWalletOpenRequest(WALLET_OPEN_URL))
  assert.ok(isWalletOpenRequest('UDSH://WALLET'))
  assert.ok(!isWalletOpenRequest('https://u-claw.org'))
  assert.ok(!isWalletOpenRequest(undefined))
})

// 这条是回归：客户实测「一路走到对话框才撞 API key is invalid」，
// 根因是钱包没就绪却没人告诉用户。以下每种未就绪都必须主动递钱包页。
test('钱包未就绪时必须主动递到用户面前', () => {
  assert.ok(shouldAutoOpenWallet(undefined), '读不到状态')
  assert.ok(shouldAutoOpenWallet({ available: false }), '离线首启没签发出来')
  assert.ok(shouldAutoOpenWallet({ available: true, pending: true }), '换 Key 没走完')
  assert.ok(shouldAutoOpenWallet({ available: true, balanceAvailable: 0 }), '余额为 0，发一句话只会报错')
})

test('已充值或余额未知时别打扰用户', () => {
  assert.ok(!shouldAutoOpenWallet({ available: true, pending: false, balanceAvailable: 12.5 }))
  assert.ok(!shouldAutoOpenWallet({ available: true, pending: false, balanceAvailable: null }))
})

test('钱包入口脚本幂等，且带稳定的非视觉标识', () => {
  const script = buildWalletEntryScript()
  assert.match(script, /getElementById\('udsh-wallet-entry'\)/, '重复注入不能出现第二个按钮')
  assert.match(script, /data-udsh-entry/, 'ActionParity：按钮要能被机器认出来，不靠像素')
  assert.match(script, /udsh:\/\/wallet/)
  assert.match(buildWalletEntryScript({ locale: 'en-US' }), /Wallet \/ Top up/)
  assert.match(buildWalletEntryScript({ locale: 'zh-CN' }), /钱包/)
})

test('exFAT 的 EISDIR 要翻成「换 NTFS」，不是裸堆栈', () => {
  const { summary, action, detail } = describeStartupFailure(new Error('EISDIR: illegal operation on a directory'))
  assert.match(summary, /junction|目录链接/)
  assert.match(action, /NTFS/)
  assert.match(detail, /EISDIR/, '原始信息必须保留，方便排查')
})

test('常见启动失败都有人话 + 可照做的动作', () => {
  for (const [raw, expected] of [
    ['ENOSPC: no space left on device', /空间/],
    ['listen EADDRINUSE: address already in use', /端口/],
    ['EPERM: operation not permitted', /权限/],
  ]) {
    const described = describeStartupFailure(new Error(raw))
    assert.match(described.summary, expected)
    assert.ok(described.action.length > 0)
  }
})

test('没有匹配规则时也给兜底文案，绝不让用户直面裸堆栈', () => {
  const described = describeStartupFailure(new Error('something nobody predicted'))
  assert.ok(described.summary.length > 0)
  assert.ok(described.action.length > 0)
  assert.equal(described.detail, 'something nobody predicted')
})

test('junction 探测：能建就 ok，建不了就带上原始错误', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'udsh-probe-'))
  try {
    const ok = await probeJunctionSupport(dir, { platform: 'win32' })
    if (process.platform === 'win32') {
      assert.equal(ok.ok, true, 'NTFS 临时目录上必须能建 junction')
    }

    const failure = await probeJunctionSupport(dir, {
      platform: 'win32',
      fsOps: {
        mkdir: async () => {},
        symlink: async () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }) },
        rm: async () => {},
      },
    })
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'EISDIR')

    const skipped = await probeJunctionSupport(dir, { platform: 'darwin' })
    assert.deepEqual(skipped, { ok: true, skipped: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('探测不留垃圾目录', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'udsh-probe-clean-'))
  try {
    await probeJunctionSupport(dir, { platform: 'win32' })
    const { readdirSync } = await import('node:fs')
    assert.deepEqual(readdirSync(dir), [], '探测完必须自己收拾干净')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
