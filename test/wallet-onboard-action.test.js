import assert from 'node:assert/strict'
import test from 'node:test'
import { buildActionRegistry } from '../src/action-core.js'

test('一键开通先收敛并配置钱包，成功后才打开充值页', async () => {
  const events = []
  const registry = buildActionRegistry({
    wallet: {
      async ensure() {
        events.push('ensure')
        return { apiKey: 'sk-test-secret', configured: true }
      },
    },
    async openRecharge() { events.push('recharge') },
  })

  const result = await registry.dispatch({ actionId: 'wallet.onboard', surface: 'gui', input: {} })
  assert.equal(result.ok, true)
  assert.deepEqual(events, ['ensure', 'recharge'])
})

test('钱包未能写入 DSH 时，一键开通不打开充值页', async () => {
  let opened = false
  const registry = buildActionRegistry({
    wallet: { ensure: async () => ({ apiKey: 'sk-test-secret', configured: false }) },
    async openRecharge() { opened = true },
  })

  const result = await registry.dispatch({ actionId: 'wallet.onboard', surface: 'gui', input: {} })
  assert.equal(result.ok, false)
  assert.equal(opened, false)
})
