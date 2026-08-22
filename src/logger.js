import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 落盘日志。
 *
 * 起因：`paths.logsDir` 以前有零个消费者 —— `preparePortablePaths()` 建了这个目录，
 * 全仓库没有一行代码往里写。而 `device-wallet.js` 的 `doEnsure()` 在签发失败时
 * 只 `console.warn` 一句就静默降级，打包后的 GUI 又没有控制台，于是「钱包没配好」
 * 这件事在磁盘上不留任何痕迹：用户一路走到对话框撞 `API key is invalid`，
 * 而我们连一份能让他发过来的日志都没有。
 *
 * 所以这里的目标不是「好看的日志框架」，是**让静默失败留下痕迹**：
 * - 同步追加写，进程被杀也不丢最后一条（启动期崩溃恰恰是最需要看的）
 * - 写失败绝不能反过来搞挂启动（只读盘、盘满、杀软锁文件都可能）
 * - 仍然镜像到 console，开发态行为不变
 */

const LEVELS = ['debug', 'info', 'warn', 'error']

function stamp(now) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}`
}

export function logFileName(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return `u-dsh-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`
}

export function formatLine(level, args, now = new Date()) {
  const body = args
    .map((value) => {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack || value.message
      try { return JSON.stringify(value) } catch { return String(value) }
    })
    .join(' ')
  return `${stamp(now)} [${level.toUpperCase()}] ${body}\n`
}

/**
 * @param logsDir 落盘目录；传空则退化为纯 console（单元测试和 CLI 用得上）。
 * @param mirror  同时写到哪个 console，默认 globalThis.console。
 */
export function createLogger(logsDir, { mirror = console, now = () => new Date() } = {}) {
  let target
  if (logsDir) {
    try {
      mkdirSync(logsDir, { recursive: true })
      target = path.join(logsDir, logFileName(now()))
    } catch {
      // 建不了目录就只剩 console —— 不值得为记日志把启动搞挂。
      target = undefined
    }
  }

  const logger = {}
  for (const level of LEVELS) {
    logger[level] = (...args) => {
      mirror?.[level === 'debug' ? 'log' : level]?.(...args)
      if (!target) return
      try {
        appendFileSync(target, formatLine(level, args, now()), 'utf8')
      } catch {
        // 只读盘 / 盘满 / 被杀软锁住：静默放弃这一条，绝不影响主流程。
      }
    }
  }
  logger.log = logger.info
  logger.file = target
  return logger
}
