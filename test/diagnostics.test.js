import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildIssueUrl, buildReport, readLogTail, redact } from '../src/diagnostics.js'

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'udsh-diag-'))
}

// 这一组是本文件存在的理由：报告会被用户原样贴进**公开** issue。
// 漏一把 Key 出去就是真金白银。宁可误伤，不许漏。
test('设备钱包 Key 必须被打码', () => {
  const out = redact('XIAPAN_CLOUD_API_KEY: sk-129b7f4e2a9c8d1e0f3b5a6c7d8e9f00')
  assert.ok(!out.includes('sk-129b7f4e2a9c8d1e0f3b5a6c7d8e9f00'))
  assert.match(out, /REDACTED/)
})

test('各种形状的凭据都要打掉', () => {
  for (const raw of [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnop',
    'password: hunter2secret',
    'SECRET_TOKEN = 9f8e7d6c5b4a3210',
  ]) {
    const out = redact(raw)
    assert.match(out, /REDACTED/, `没打码：${raw}`)
  }
})

test('打码保留前缀，方便对人说"是这把 Key"而不泄露它', () => {
  assert.match(redact('sk-129b7f4e2a9c8d1e'), /^sk-129…REDACTED$/)
})

test('普通日志不该被误伤成一片 REDACTED', () => {
  const line = '2026-08-23 00:12:03.114 [INFO] [launch] U-DSH Portable 启动，数据目录 I:\\U-DSH\\data'
  assert.equal(redact(line), line)
})

test('报告正文整体过一遍打码，任何字段都别想漏出去', () => {
  const body = buildReport({
    appVersion: '0.2.0',
    kernelStatus: { nodeVersion: '24.19.0', nodeReady: true, pinnedVersion: '0.1.0-rc.7', cacheDir: 'C:\\a', dataDir: 'I:\\b' },
    walletStatus: { available: true, pending: false, balanceAvailable: 1, balanceError: 'bad key sk-abcdef123456' },
    logTail: 'XIAPAN_CLOUD_API_KEY: sk-zzzzzzzzzzzzzz',
  })
  assert.ok(!body.includes('sk-abcdef123456'))
  assert.ok(!body.includes('sk-zzzzzzzzzzzzzz'))
  assert.match(body, /0\.2\.0/)
  assert.match(body, /24\.19\.0/)
})

test('连打码后的 Key 都不放进报告——免得诱导用户以为贴 Key 是正常的', () => {
  const body = buildReport({
    appVersion: '0.2.0',
    walletStatus: { available: true, apiKeyMasked: 'sk-129b…cfe19e', pending: false, balanceAvailable: 1 },
  })
  assert.ok(!body.includes('cfe19e'))
})

test('内核或钱包读不到时报告照样出得来（用户正是在坏掉时才点它）', () => {
  const body = buildReport({ appVersion: '0.2.0', kernelStatus: null, walletStatus: null, logTail: '' })
  assert.match(body, /读不到内核状态/)
  assert.match(body, /读不到钱包状态/)
})

test('日志尾巴：能读到就打码后返回', () => {
  const dir = scratch()
  try {
    writeFileSync(path.join(dir, 'u-dsh-2026-08-22.log'), '旧的\n')
    writeFileSync(path.join(dir, 'u-dsh-2026-08-23.log'), '新的一行\nsk-shouldnotleak12345\n')
    const tail = readLogTail(dir)
    assert.match(tail, /新的一行/)
    assert.ok(!tail.includes('sk-shouldnotleak12345'), '日志里的 Key 必须打码')
    assert.ok(!tail.includes('旧的'), '只取最近那个文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有日志时如实说，不要静默返回空让人以为一切正常', () => {
  const dir = scratch()
  try {
    assert.match(readLogTail(dir), /空的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(readLogTail(path.join(' nope', 'missing')), /没有日志目录/)
})

test('issue 链接可用，正文过长会截断而不是生成一个打不开的 URL', () => {
  const url = buildIssueUrl(buildReport({ appVersion: '0.2.0' }))
  assert.ok(url.startsWith('https://github.com/'))
  const parsed = new URL(url)
  assert.match(parsed.searchParams.get('body') || '', /U-DSH 版本：0\.2\.0/)

  const huge = buildIssueUrl(`${'x'.repeat(20_000)}`)
  assert.ok(huge.length < 20_000, '过长必须截断')
  assert.match(decodeURIComponent(huge), /已截断/)
})
