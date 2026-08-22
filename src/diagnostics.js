import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 一键问题报告。
 *
 * 为什么要做：用户不会自己去翻日志。没有诊断信息的 issue 等于「打不开」三个字，
 * 来回问三轮才能定位一次。这里把版本、系统、内核状态和日志尾巴一次性收好，
 * 生成预填的 GitHub issue 链接，用户点一下就行。
 *
 * 铁律：**任何输出都必须先打码。** 日志里可能有设备钱包的 Key，
 * 用户会把整段贴到公开 issue 里。打码在这一层做，不指望用户自己检查。
 */

const ISSUE_URL = 'https://github.com/dongsheng123132/u-dsh-deepseek-harness-portable/issues/new'

/** GitHub issue body 的 URL 长度上限保守取值，超了就截断日志。 */
const MAX_BODY = 6000
const LOG_TAIL_LINES = 60

/**
 * 打码一切像凭据的东西。宁可误伤也不能漏：
 * - `sk-` 开头的 Key（虾盘云、DeepSeek、OpenAI 都是这个形状）
 * - Bearer token
 * - 形如 `xxx_KEY: value` / `xxx_TOKEN=value` 的赋值
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}/g, (match) => `${match.slice(0, 6)}…REDACTED`)
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer …REDACTED')
    .replace(/((?:API|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*\s*[:=]\s*)("?)[^\s"']{6,}\2/gi,
      (_match, prefix) => `${prefix}…REDACTED`)
}

/** 取最近一个日志文件的尾巴。读不到就如实说读不到，不要静默返回空。 */
export function readLogTail(logsDir, { lines = LOG_TAIL_LINES } = {}) {
  if (!logsDir || !existsSync(logsDir)) return '(没有日志目录)'
  let names
  try {
    names = readdirSync(logsDir).filter((name) => name.endsWith('.log')).sort()
  } catch (error) {
    return `(读日志目录失败：${error?.message})`
  }
  if (names.length === 0) return '(日志目录是空的)'
  const latest = path.join(logsDir, names[names.length - 1])
  try {
    const body = readFileSync(latest, 'utf8').split(/\r?\n/).filter(Boolean)
    return redact(body.slice(-lines).join('\n')) || '(日志是空的)'
  } catch (error) {
    return `(读 ${names[names.length - 1]} 失败：${error?.message})`
  }
}

/**
 * 组装报告正文。所有字段都经过打码，可以直接贴进公开 issue。
 */
export function buildReport({
  appVersion,
  kernelStatus,
  walletStatus,
  logTail,
  platform = process.platform,
  arch = process.arch,
  osRelease = '',
  logsDir = '',
} = {}) {
  const wallet = walletStatus
    ? [
        `- 已签发：${walletStatus.available ? '是' : '否'}`,
        `- 有未完成操作：${walletStatus.pending ? `是（${walletStatus.pendingKind || '未知'}）` : '否'}`,
        `- 余额：${walletStatus.balanceAvailable ?? '未查询到'}`,
        walletStatus.balanceError ? `- 余额查询错误：${redact(walletStatus.balanceError)}` : null,
      ].filter(Boolean).join('\n')
    : '- 读不到钱包状态'

  const kernel = kernelStatus
    ? [
        `- 随包 Node：${kernelStatus.nodeVersion}（就绪：${kernelStatus.nodeReady ? '是' : '否'}）`,
        `- DSH 版本：${kernelStatus.pinnedVersion}`,
        `- 内核目录：${kernelStatus.cacheDir}`,
        `- 数据目录：${kernelStatus.dataDir}`,
      ].join('\n')
    : '- 读不到内核状态'

  // 注意钱包 Key 本身一个字都不进报告 —— 连打码后的都不放，
  // 状态里的 apiKeyMasked 对排查没用，却会诱导用户以为「贴 Key 是正常的」。
  const body = [
    '## 出了什么问题',
    '',
    '<!-- 请在这里写：你做了什么、看到了什么、期望是什么 -->',
    '',
    '## 自动收集的诊断信息',
    '',
    '<!-- 下面由「报告问题」自动生成，Key 已打码。核对无误后直接提交即可。 -->',
    '',
    `- U-DSH 版本：${appVersion || '未知'}`,
    `- 系统：${platform} ${arch} ${osRelease}`.trimEnd(),
    '',
    '**内核**',
    kernel,
    '',
    '**设备钱包**',
    wallet,
    '',
    `**日志尾巴**（完整日志在 \`${logsDir || 'logs 目录'}\`）`,
    '',
    '```text',
    logTail || '(无)',
    '```',
    '',
  ].join('\n')

  return redact(body)
}

/** 生成预填的 GitHub issue URL；正文过长时截断日志段，保证链接可用。 */
export function buildIssueUrl(report, { title = '[bug] ' } = {}) {
  let body = report
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n…（日志过长已截断，请手动附上完整日志文件）\n`
  }
  const query = new URLSearchParams({ title, body, labels: 'bug' })
  return `${ISSUE_URL}?${query.toString()}`
}
