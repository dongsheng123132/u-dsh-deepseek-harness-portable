// U-DSH Web 便携启动器（跨平台）
// 引擎（Node 运行时 + DSH 闭包）默认装到本机硬盘，DSH_HOME 指向 U 盘 data/；
// 这样「大块头在本机、数据随盘走」，换电脑首次自动装一次，之后本机高速启动。
// 用法: <node> web-launch.cjs
// 环境变量:
//   UDSH_ENGINE_MODE=auto|host|drive|temp|usb   引擎位置（默认 auto = 一律装本机）
//   UDSH_FORCE_DRIVE_ENGINE=1                   auto 时强制把引擎装到盘上
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveEngine } = require('./engine-install.cjs')
const { createDeviceWallet } = require('./device-wallet.cjs')

/**
 * 同一份 U 盘数据被两台电脑同时用，会话/配置会互相覆盖。
 * Windows 上拔盘前不弹出更是常态，所以启动时只做**告警**、不阻断：
 * 锁文件写 host+pid，跨主机且 12 小时内 → 明确提示风险。
 */
function checkConcurrentUse(dataRoot) {
  const lockPath = path.join(dataRoot, '.udsh-instance.lock')
  const host = os.hostname()
  let previous = null
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age < 12 * 60 * 60 * 1000) previous = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch { /* 没锁或读不了都当没有 */ }
  if (previous && previous.host && previous.host !== host) {
    console.warn(`[U-DSH] ⚠ 这份数据最近在另一台电脑（${previous.host}）上使用过。`)
    console.warn('[U-DSH]   同一支 U 盘在多台电脑同时使用会让会话/配置互相覆盖；如非本人操作，建议先备份 data/dsh-home。')
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ host, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n')
  } catch { /* 只读盘就算了 */ }
  const release = () => { try { rmSync(lockPath, { force: true }) } catch {} }
  process.once('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { release(); process.exit(0) })
  }
}

async function main() {
  // 解析（必要时安装）引擎，并拿到数据目录（永远在 U 盘上）。
  const engine = resolveEngine({ appRoot: __dirname })
  console.log('[U-DSH] 引擎模式：' + engine.mode + ' → ' + engine.engineRoot)
  console.log('[U-DSH] 数据目录（随盘）：' + engine.dataRoot)
  try { mkdirSync(engine.dataRoot, { recursive: true }) } catch {}
  checkConcurrentUse(engine.dataRoot)

  const args = [engine.entry, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']
  const env = Object.assign({}, process.env, { DSH_HOME: engine.dataRoot })

  // 设备钱包：给 DSH 自动配好模型。C1——失败/断网/只读盘都不能挡住启动。
  const portableRoot = path.resolve(engine.dataRoot, '..', '..')
  let wallet = null
  try {
    wallet = createDeviceWallet({ root: portableRoot, engineRoot: engine.engineRoot })
    const ready = await wallet.ensure()
    if (ready.apiKey) {
      console.log(`[U-DSH] 设备钱包：${ready.walletId || '(未命名)'}　密钥 ${wallet.maskApiKey(ready.apiKey)}`)
      console.log(ready.configured ? '[U-DSH] 已自动配置「虾盘云」为默认模型来源' : '[U-DSH] 钱包已就绪，但本次没能写入 DSH 配置（可稍后双击「钱包」重试）')
      try {
        const status = await wallet.status({ refreshBalance: true })
        const available = status.balance?.available
        if (available != null) {
          // 余额按 ¥ 显示（虾盘云 1 元 = 50 万 token），客户看得懂
          const yuan = (Number(available) / 500000).toFixed(2)
          console.log(`[U-DSH] 余额：¥${yuan}（${Number(available).toLocaleString()} tokens）`)
          if (available <= 1) {
            console.log('[U-DSH] ─────────────────────────────────────────────')
            console.log('[U-DSH]  钱包还没充值。要充值：双击 U 盘里的「充值」')
            console.log('[U-DSH]  看余额 / 换 Key：双击「钱包」；充完回到 DSH 里直接对话')
            console.log('[U-DSH] ─────────────────────────────────────────────')
            // 想让它自动弹充值页，设 UDSH_AUTO_RECHARGE=1（默认不弹，免得客户以为被强推付款）
            if (process.env.UDSH_AUTO_RECHARGE === '1') {
              try {
                const url = await wallet.rechargeUrl()
                const opener = process.platform === 'win32'
                  ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
                  : spawn('open', [url], { stdio: 'ignore' })
                void opener
              } catch { /* 打不开就算了，提示已经打过了 */ }
            }
          }
        }
      } catch { /* 余额查不到不影响启动 */ }
    } else {
      console.log('[U-DSH] 没领到设备钱包（可能没网）：DSH 照常启动，联网后下次启动会自动领取；也可以在「钱包」里填自己的 Key')
    }
  } catch (error) {
    console.warn(`[U-DSH] 设备钱包跳过：${error.message}`)
  }

  // 钱包面板随启动器一起起来（不自动开浏览器），终端里给个可点链接：
  // 客户想充值时点一下就开，不用去找 .bat/.command。
  if (wallet) {
    try {
      const { startWalletPanel } = require('./wallet-panel.cjs')
      const panel = await startWalletPanel({ root: portableRoot, engineRoot: engine.engineRoot, open: false })
      console.log(`[U-DSH] 钱包面板：${panel.url} （余额 / 充值 / 换 Key，点开即用）`)
    } catch (error) {
      console.warn(`[U-DSH] 钱包面板没起来（不影响使用）：${error.message}`)
    }
  }

  console.log('[U-DSH] 启动 DeepSeek Harness Web 内核…')
  const child = spawn(engine.nodeExe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  const READY = /^dsh web: (\S+)\b/m
  let opened = false
  const onData = (chunk) => {
    output += chunk.toString()
    if (opened) return
    const m = READY.exec(output)
    if (m) {
      opened = true
      const url = m[1]
      console.log('[U-DSH] 已就绪：' + url)
      const opener =
        process.platform === 'win32'
          ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
          : spawn('open', [url], { stdio: 'ignore' })
      void opener
    }
    // 仅打印部分输出，避免刷屏
    if (!opened && output.length > 2048) output = output.slice(-1024)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.once('error', (err) => {
    console.error('[U-DSH] 启动失败：' + err.message)
    process.exit(1)
  })
  child.once('exit', (code, signal) => {
    console.log('[U-DSH] 内核已退出 (' + code + ', ' + signal + ')')
    process.exit(code == null ? 0 : code)
  })

  // 启动器退出时把内核一起带走：不然关掉终端窗口后内核会变成孤儿进程，
  // 继续占着端口和文件句柄（实测残留过十几个）。Windows 上关闭 cmd 窗口属于强杀，
  // 收不到信号，这点只能靠内核自身的空闲退出兜底；macOS/Linux 正常收尾。
  const killChild = () => {
    if (child.exitCode != null || child.signalCode != null) return
    try { child.kill('SIGTERM') } catch {}
  }
  process.once('exit', killChild)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { killChild(); process.exit(0) })
  }
}

main().catch((error) => { console.error(`[U-DSH] 启动失败：${error.message}`); process.exit(1) })
