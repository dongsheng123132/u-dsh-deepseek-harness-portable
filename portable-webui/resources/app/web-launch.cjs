// U-DSH Web 便携启动器（跨平台）
// 引擎（Node 运行时 + DSH 闭包）默认装到本机硬盘，DSH_HOME 指向 U 盘 data/；
// 这样「大块头在本机、数据随盘走」，换电脑首次自动装一次，之后本机高速启动。
// 用法: <node> web-launch.cjs
// 环境变量:
//   UDSH_ENGINE_MODE=auto|host|drive|temp|usb   引擎位置（默认 auto）
//   UDSH_HDD_THRESHOLD_GB=64                    auto 时判定「移动硬盘」的容量阈值
'use strict'
const { spawn } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { resolveEngine } = require('./engine-install.cjs')

function main() {
  // 解析（必要时安装）引擎，并拿到数据目录（永远在 U 盘上）。
  const engine = resolveEngine({ appRoot: __dirname })
  console.log('[U-DSH] 引擎模式：' + engine.mode + ' → ' + engine.engineRoot)
  console.log('[U-DSH] 数据目录（随盘）：' + engine.dataRoot)
  try { mkdirSync(engine.dataRoot, { recursive: true }) } catch {}

  const args = [engine.entry, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']
  const env = Object.assign({}, process.env, { DSH_HOME: engine.dataRoot })

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
}

main()
