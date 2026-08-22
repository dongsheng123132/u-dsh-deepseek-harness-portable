import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import test, { after } from 'node:test'
import { attachElectronIpc } from 'action-parity-sdk/electron'
import { createCliRunner } from 'action-parity-sdk/cli'
import { buildActionRegistry } from '../src/action-core.js'

const observations = []
const manifest = JSON.parse(await readFile(new URL('../generated/action-parity.json', import.meta.url), 'utf8'))
const walletHtml = await readFile(new URL('../src/wallet.html', import.meta.url), 'utf8')

function fakeServices() {
  let copied = 0
  let opened = 0
  let reported = 0
  const wallet = {
    status: async () => ({
      available: true,
      apiKeyMasked: 'sk-test…masked',
      walletId: 'wallet-test',
      pending: false,
      pendingKind: '',
      balance: { available: 100 },
    }),
    ensure: async () => ({ apiKey: 'sk-test-secret', configured: true }),
    currentApiKey: async () => 'sk-test-secret',
    rotate: async () => ({ message: 'rotated', apiKeyMasked: 'sk-new…masked' }),
    adopt: async () => ({ message: 'adopted', apiKeyMasked: 'sk-old…masked' }),
    resetLocal: async () => ({ message: 'reset', apiKeyMasked: 'sk-zero…masked' }),
  }
  const kernel = {
    status: async () => ({
      nodeVersion: '24.19.0', nodeReady: true, pinnedVersion: '0.1.0-rc.7',
      activeVersion: '0.1.0-rc.7', installedVersions: ['0.1.0-rc.7'],
      cacheDir: 'C:\\cache', dataDir: 'I:\\U-DSH\\data\\dsh-home',
    }),
    checkLatest: async () => ({ current: '0.1.0-rc.7', pinned: '0.1.0-rc.7', latest: '0.1.0-rc.7' }),
  }
  return {
    registry: buildActionRegistry({
      wallet,
      kernel,
      copyCurrentKey: async () => { copied += 1 },
      openRecharge: async () => { opened += 1 },
      reportProblem: async () => { reported += 1 },
    }),
    copied: () => copied,
  }
}

const inputFor = (actionId) => actionId === 'wallet.key.adopt'
  ? { apiKey: 'sk-test-secret' }
  : actionId === 'wallet.status'
    ? { refreshBalance: true }
    : {}

after(async () => {
  await writeFile(
    new URL('../generated/parity-observations.json', import.meta.url),
    `${JSON.stringify(observations, null, 2)}\n`,
    'utf8',
  )
})

test('every GUI binding has a stable data-action-id in the wallet window', () => {
  for (const action of manifest.actions) {
    const binding = action.bindings.find(({ surface }) => surface === 'gui')
    assert.ok(binding, `${action.id} has no GUI binding`)
    assert.match(walletHtml, new RegExp(`data-action-id=["']${action.id.replaceAll('.', '\\.')}["']`))
  }
})

test('high-risk wallet actions are refused without core confirmation', async () => {
  const { registry } = fakeServices()
  for (const actionId of ['wallet.key.rotate', 'wallet.reset_local']) {
    const envelope = await registry.dispatch({ actionId, surface: 'cli', input: {} })
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'confirmation_required')
  }
})

test('CLI refuses secret input in argv and accepts stdin', async () => {
  const { registry } = fakeServices()
  const rejected = await invokeCli(registry, 'wallet.key.adopt', { apiKey: 'sk-test-secret' }, 'secret-rejected', false, true)
  assert.equal(rejected.code, 2)
  assert.match(rejected.envelope.error.message, /argv is refused|may not be passed in argv/)

  const accepted = await invokeCli(registry, 'wallet.key.adopt', { apiKey: 'sk-test-secret' }, 'secret-stdin')
  assert.equal(accepted.code, 0)
  assert.equal(accepted.envelope.ok, true)
})

for (const surface of ['gui', 'cli']) {
  test(`${surface} reaches the same Action Core for every declared Action`, async () => {
    const { registry } = fakeServices()
    for (const action of manifest.actions) {
      const executionId = `evidence-${surface}-${action.id}`
      const envelope = surface === 'gui'
        ? await invokeGui(registry, action.id, inputFor(action.id), executionId)
        : (await invokeCli(registry, action.id, inputFor(action.id), executionId)).envelope
      assert.equal(envelope.ok, true, JSON.stringify(envelope))
      assert.equal(envelope.execution_id, executionId)
      assert.equal(envelope.result.coreExecutionId, executionId)
      observations.push({
        action_id: action.id,
        surface,
        request_execution_id: executionId,
        core_execution_id: envelope.result.coreExecutionId,
      })
    }
  })
}

async function invokeGui(registry, actionId, input, executionId) {
  const handlers = new Map()
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  }
  const detach = attachElectronIpc(ipcMain, registry, { surface: 'gui', confirm: () => true })
  try {
    return await handlers.get('action-parity:call')({}, { actionId, input, executionId })
  } finally {
    detach()
  }
}

async function invokeCli(registry, actionId, input, executionId, inlineSecret = false, secretFlag = false) {
  let stdout = ''
  let stderr = ''
  const output = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback() } })
  const errors = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback() } })
  const stdin = Readable.from([`${JSON.stringify(input)}\n`])
  const runner = createCliRunner(registry, { name: 'u-dsh', stdout: output, stderr: errors, stdin })
  const args = [actionId, '--json', '--execution-id', executionId]
  if (secretFlag) args.push('--apiKey', input.apiKey)
  else args.push('--input-json', inlineSecret ? JSON.stringify(input) : actionId === 'wallet.key.adopt' ? '-' : JSON.stringify(input))
  if (['wallet.key.rotate', 'wallet.reset_local'].includes(actionId)) args.push('--yes')
  const code = await runner.run(args)
  return { code, envelope: JSON.parse(stdout), stderr }
}
