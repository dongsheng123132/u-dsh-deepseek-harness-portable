import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('钱包首屏只保留一条一键开通路径，复杂操作收进管理区', async () => {
  const html = await readFile(new URL('../src/wallet.html', import.meta.url), 'utf8')

  assert.match(html, /id="onboard" data-action-id="wallet\.onboard">一键开通并充值/)
  assert.match(html, /不会自动扣费/)
  assert.match(html, /<details>[\s\S]*管理钱包、备份或换机/)
  assert.doesNotMatch(html, /DSH 内核/)
  assert.doesNotMatch(html, /检查官方更新/)
  assert.doesNotMatch(html, /报告问题/)
})

test('一键开通入口经过统一动作核心，不在渲染器拼接多个副作用', async () => {
  const preload = await readFile(new URL('../src/wallet-preload.cjs', import.meta.url), 'utf8')
  const core = await readFile(new URL('../src/action-core.js', import.meta.url), 'utf8')

  assert.match(preload, /onboard: \(\) => action\('wallet\.onboard'\)/)
  assert.match(core, /id: 'wallet\.onboard'/)
  assert.match(core, /const ensured = await wallet\.ensure\(\)/)
  assert.match(core, /await openRecharge\(\)/)
})
