import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRegistry, defineAction, defineSurface, s } from 'action-parity-sdk'

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const EMPTY_INPUT = s.object({})
const MESSAGE_OUTPUT = s.object({ message: s.string(), coreExecutionId: s.string() })
const KEY_MESSAGE_OUTPUT = s.object({ message: s.string(), apiKeyMasked: s.string(), coreExecutionId: s.string() })

function normalizedWalletStatus(value) {
  const balanceAvailable = Number(value?.balance?.available)
  return {
    available: Boolean(value?.available),
    apiKeyMasked: value?.apiKeyMasked || '',
    walletId: value?.walletId || '',
    pending: Boolean(value?.pending),
    pendingKind: value?.pendingKind || '',
    balanceAvailable: Number.isFinite(balanceAvailable) ? balanceAvailable : null,
    balanceError: value?.balance?.error || '',
  }
}

export function buildActionRegistry({ wallet, kernel, copyCurrentKey, openRecharge, reportProblem } = {}) {
  if (!wallet || !kernel) throw new Error('wallet 和 kernel 是必填项')
  const registry = createRegistry({
    application: {
      id: 'org.uclaw.udsh',
      name: 'U-DSH Portable',
      version: packageJson.version,
      description: 'Portable DeepSeek Harness with Xiapan Cloud device wallet.',
      source: 'https://github.com/dongsheng123132/u-dsh-deepseek-harness-portable',
    },
    generatorRevision: 'src/action-core.js',
    cli: { invocation: 'u-dsh <action-id> [--flag value] --json' },
    surfaces: [
      defineSurface({
        id: 'gui',
        kind: 'gui',
        reachability: 'in-process',
        bindingTarget: 'data-action-id={action_id}',
        bindingTest: 'test/action-parity.test.js',
        testDriver: 'node --test',
      }),
      defineSurface({
        id: 'cli',
        kind: 'cli',
        reachability: 'external',
        bindingTarget: 'u-dsh {action_id} --json',
        bindingTest: 'test/action-parity.test.js',
        testDriver: 'node --test',
      }),
    ],
  })

  registry.registerAll([
    defineAction({
      id: 'wallet.status',
      title: '读取设备钱包状态',
      description: '读取脱敏 Key、余额和待完成操作，不返回原始 Key。',
      effects: 'read',
      execution: { idempotent: true, timeout_ms: 25_000, evidence: 'node --test test/action-parity.test.js' },
      input: s.object({ refreshBalance: s.optional(s.boolean({ default: false })) }),
      output: s.object({
        available: s.boolean(),
        apiKeyMasked: s.string(),
        walletId: s.string(),
        pending: s.boolean(),
        pendingKind: s.string(),
        balanceAvailable: s.nullable(s.number()),
        balanceError: s.string(),
        coreExecutionId: s.string(),
      }),
      handler: async (input, context) => ({
        ...normalizedWalletStatus(await wallet.status(input)),
        coreExecutionId: context.executionId,
      }),
    }),
    defineAction({
      id: 'wallet.ensure',
      title: '收敛设备钱包',
      description: '恢复未完成操作，必要时申领随机 Key，并写入 DSH 配置。',
      effects: { class: 'external', risk: 'low', reversible: true },
      execution: { idempotent: true, timeout_ms: 30_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: s.object({ available: s.boolean(), configured: s.boolean(), coreExecutionId: s.string() }),
      handler: async (_input, context) => {
        const value = await wallet.ensure()
        return { available: Boolean(value?.apiKey), configured: Boolean(value?.configured), coreExecutionId: context.executionId }
      },
    }),
    defineAction({
      id: 'wallet.key.copy',
      title: '复制设备钱包 Key',
      description: '在主进程内把当前 Key 写入系统剪贴板，Key 不进入渲染器。',
      effects: 'read',
      execution: { idempotent: true, timeout_ms: 5_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: MESSAGE_OUTPUT,
      handler: async (_input, context) => {
        if (!copyCurrentKey) throw new Error('当前界面不支持系统剪贴板')
        await copyCurrentKey()
        return { message: 'Key 已复制，请自行安全备份', coreExecutionId: context.executionId }
      },
    }),
    defineAction({
      id: 'wallet.recharge.open',
      title: '打开设备钱包充值页',
      description: '在系统浏览器打开当前钱包的充值页面；充值 URL 含 Key，不进入输出。',
      effects: { class: 'external', risk: 'low', reversible: true },
      execution: { idempotent: true, timeout_ms: 15_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: MESSAGE_OUTPUT,
      handler: async (_input, context) => {
        if (!openRecharge) throw new Error('当前界面不支持打开系统浏览器')
        await openRecharge()
        return { message: '已打开充值页面，完成后回来点「刷新余额」', coreExecutionId: context.executionId }
      },
    }),
    defineAction({
      id: 'support.report_problem',
      title: '报告问题',
      description: '收集版本、内核与钱包状态和日志摘要，打开预填的 GitHub issue；凭据已打码，Key 本身不进报告。',
      effects: { class: 'external', risk: 'low', reversible: true },
      execution: { idempotent: true, timeout_ms: 20_000, evidence: 'node --test test/diagnostics.test.js' },
      input: EMPTY_INPUT,
      output: MESSAGE_OUTPUT,
      handler: async (_input, context) => {
        if (!reportProblem) throw new Error('当前界面不支持打开系统浏览器')
        await reportProblem()
        return { message: '已打开问题反馈页，诊断信息已填好（Key 已打码），补一句问题描述就能提交', coreExecutionId: context.executionId }
      },
    }),
    defineAction({
      id: 'wallet.key.rotate',
      title: '更换设备钱包 Key',
      description: '生成并验证新 Key，提交后旧 Key 失效，钱包余额不变。',
      effects: { class: 'financial', risk: 'high', reversible: false, confirmation: 'always' },
      execution: { timeout_ms: 30_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: KEY_MESSAGE_OUTPUT,
      handler: async (_input, context) => ({ ...await wallet.rotate(), coreExecutionId: context.executionId }),
    }),
    defineAction({
      id: 'wallet.key.adopt',
      title: '启用已有设备钱包 Key',
      description: '只读验证已有 Key，成功后写入 U 盘钱包和 DSH 配置。',
      effects: { class: 'write', risk: 'medium', reversible: true },
      execution: { timeout_ms: 30_000, evidence: 'node --test test/action-parity.test.js' },
      input: {
        type: 'object',
        properties: {
          apiKey: {
            type: 'string',
            minLength: 8,
            writeOnly: true,
            description: 'Secret. CLI callers must use --input-json - or @file; argv flags are refused.',
          },
        },
        required: ['apiKey'],
        additionalProperties: false,
      },
      output: KEY_MESSAGE_OUTPUT,
      handler: async ({ apiKey }, context) => ({ ...await wallet.adopt(apiKey), coreExecutionId: context.executionId }),
    }),
    defineAction({
      id: 'wallet.reset_local',
      title: '移除本机设备钱包',
      description: '先清除 DSH 消费端配置，再清 U 盘本地钱包；不会删除服务端钱包和余额。',
      effects: { class: 'destructive', risk: 'high', reversible: false, confirmation: 'always' },
      execution: { timeout_ms: 30_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: KEY_MESSAGE_OUTPUT,
      handler: async (_input, context) => ({ ...await wallet.resetLocal(), coreExecutionId: context.executionId }),
    }),
    defineAction({
      id: 'kernel.status',
      title: '读取 DSH 内核状态',
      description: '读取随包 Node/DSH 内核版本和 U 盘数据目录，纯本地校验。',
      effects: 'read',
      // 校验会遍历整个 vendor 闭包（250+ 包）的 peer 解析，冷盘实测 10s+，5s 必超时。
      execution: { idempotent: true, timeout_ms: 30_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: s.object({
        nodeVersion: s.string(),
        nodeReady: s.boolean(),
        pinnedVersion: s.string(),
        activeVersion: s.nullable(s.string()),
        installedVersions: s.array(s.string()),
        cacheDir: s.string(),
        dataDir: s.string(),
        coreExecutionId: s.string(),
      }),
      handler: async (_input, context) => ({ ...await kernel.status(), coreExecutionId: context.executionId }),
    }),
    defineAction({
      id: 'kernel.check_updates',
      title: '检查 DSH 内核更新',
      description: '只读查询 npm latest 标签，不自动安装；网络不通时 latest 为空串且不报错。',
      effects: 'read',
      execution: { idempotent: true, timeout_ms: 20_000, evidence: 'node --test test/action-parity.test.js' },
      input: EMPTY_INPUT,
      output: s.object({
        current: s.nullable(s.string()),
        pinned: s.string(),
        latest: s.string(),
        updateAvailable: s.boolean(),
        coreExecutionId: s.string(),
      }),
      handler: async (_input, context) => {
        const value = await kernel.checkLatest('latest')
        // latest 为空串 = 网络不可达（unknown），不能误报有更新。
        return {
          ...value,
          updateAvailable: Boolean(value.latest) && value.latest !== value.pinned,
          coreExecutionId: context.executionId,
        }
      },
    }),
  ])

  return registry
}
