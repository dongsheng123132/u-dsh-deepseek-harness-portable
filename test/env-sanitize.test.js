import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_ENV_VARS, sanitizeRuntimeEnv } from '../src/env-sanitize.js'

test('清单包含常见第三方 provider 凭证（含 DEEPSEEK_API_KEY / OPENAI_API_KEY）', () => {
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DASHSCOPE_API_KEY', 'KIMI_API_KEY']) {
    assert.ok(PROVIDER_ENV_VARS.includes(name), `missing ${name}`)
  }
})

test('剥离宿主残留的 provider 凭证，且不报值', () => {
  const { env, stripped } = sanitizeRuntimeEnv({
    DEEPSEEK_API_KEY: 'sk-host-secret-1',
    OPENAI_API_KEY: 'sk-host-secret-2',
    PATH: 'C:\\bin',
  })
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.PATH, 'C:\\bin')
  assert.deepEqual(stripped.sort(), ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
})

test('保留 U-DSH 自身变量与系统变量', () => {
  const { env, stripped } = sanitizeRuntimeEnv({
    UDSH_DEFAULT_MODEL: 'deepseek-v4-pro',
    UDSH_VENDOR_ROOT: 'D:\\vendor',
    UDSH_PORTABLE_ROOT: 'F:\\',
    UCLAW_API_BASE_URL: 'https://api.u-claw.org/v1',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    XDG_CACHE_HOME: 'C:\\Users\\x\\.cache',
  })
  assert.equal(env.UDSH_DEFAULT_MODEL, 'deepseek-v4-pro')
  assert.equal(env.UDSH_VENDOR_ROOT, 'D:\\vendor')
  assert.equal(env.UDSH_PORTABLE_ROOT, 'F:\\')
  assert.equal(env.UCLAW_API_BASE_URL, 'https://api.u-claw.org/v1')
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\x\\AppData\\Local')
  assert.equal(env.XDG_CACHE_HOME, 'C:\\Users\\x\\.cache')
  assert.deepEqual(stripped, [])
})

test('空值/空白值不算凭证，不剥', () => {
  const { env, stripped } = sanitizeRuntimeEnv({ DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '   ' })
  assert.equal(env.DEEPSEEK_API_KEY, '')
  assert.equal(env.OPENAI_API_KEY, '   ')
  assert.deepEqual(stripped, [])
})

test('幂等：对已净化的环境再次调用不改变任何值', () => {
  const first = sanitizeRuntimeEnv({ DEEPSEEK_API_KEY: 'sk-x', KIMI_API_KEY: 'sk-y' })
  const second = sanitizeRuntimeEnv(first.env)
  assert.deepEqual(second.env, first.env)
  assert.deepEqual(second.stripped, [])
})
