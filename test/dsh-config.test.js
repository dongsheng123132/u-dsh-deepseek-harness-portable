import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { createDshConfigManager, XIAPAN_CREDENTIAL_REF, XIAPAN_PROVIDER_ID } from '../src/dsh-config.js'

test('DSH config keeps the secret in credentials and preserves unrelated settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-config-test-'))
  const endpoints = { apiBase: 'https://api.test/v1' }
  try {
    await writeFile(path.join(root, 'settings.yaml'), 'theme: dark\nllm-pi-ai:\n  providers:\n    other:\n      displayName: Other\n')
    const manager = createDshConfigManager({
      dshHome: root,
      endpoints,
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-v3' }, { id: 'deepseek-v3' }] }), { status: 200 }),
    })

    const result = await manager.applyKey('sk-secret-123456')
    const credentials = parse(await readFile(manager.credentialsPath, 'utf8'))
    const settingsText = await readFile(manager.settingsPath, 'utf8')
    const settings = parse(settingsText)

    assert.equal(result.modelCount, 1)
    assert.equal(credentials[XIAPAN_CREDENTIAL_REF], 'sk-secret-123456')
    assert.equal(settingsText.includes('sk-secret-123456'), false)
    assert.equal(settings.theme, 'dark')
    assert.equal(settings['llm-pi-ai'].providers.other.displayName, 'Other')
    assert.equal(settings['llm-pi-ai'].providers[XIAPAN_PROVIDER_ID].apiKeyEnv, XIAPAN_CREDENTIAL_REF)
    assert.deepEqual(settings['agent-default-model'], { provider: XIAPAN_PROVIDER_ID, model: 'deepseek-v3' })

    await manager.applyKey(null)
    const clearedCredentials = parse(await readFile(manager.credentialsPath, 'utf8'))
    const clearedSettings = parse(await readFile(manager.settingsPath, 'utf8'))
    assert.equal(XIAPAN_CREDENTIAL_REF in clearedCredentials, false)
    assert.equal(XIAPAN_PROVIDER_ID in (clearedSettings['llm-pi-ai']?.providers ?? {}), false)
    assert.equal(clearedSettings.theme, 'dark')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Xiapan wallet does not replace an existing non-Xiapan default provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u-dsh-provider-test-'))
  try {
    await writeFile(path.join(root, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: deepseek-official',
      '  model: deepseek-chat',
      '',
    ].join('\n'))
    const manager = createDshConfigManager({
      dshHome: root,
      endpoints: { apiBase: 'https://api.test/v1' },
      fetch: async () => new Response(JSON.stringify({ data: [{ id: 'xiapan-model' }] }), { status: 200 }),
    })

    await manager.applyKey('sk-secret-123456')
    const settings = parse(await readFile(manager.settingsPath, 'utf8'))
    assert.deepEqual(settings['agent-default-model'], {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    assert.equal(Boolean(settings['llm-pi-ai'].providers[XIAPAN_PROVIDER_ID]), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
