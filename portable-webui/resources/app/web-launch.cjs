// U-DSH Web 便携启动器（跨平台）
// 用目录内 node 启动 @deepseek-ai/dsh web 内核，DSH_HOME 指向盘内 data/，自动打开浏览器。
// 用法: <node> web-launch.js
'use strict'
const { spawn } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const ROOT = __dirname // resources/app（u-dsh 应用根）
const RUNTIME = path.join(ROOT, 'runtime')
const NODE_MODULES = path.join(ROOT, 'node_modules')
const DATA_DIR = path.join(ROOT, '..', '..', 'data', 'dsh-home') // app/portable-apps/u-dsh/data/dsh-home

function pickNode() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32') return path.join(RUNTIME, 'node-win-x64', 'node.exe')
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? 'node-mac-arm64' : 'node-mac-x64'
    return path.join(RUNTIME, dir, 'bin', 'node')
  }
  return null
}

function pickDshEntry() {
  const candidate = path.join(NODE_MODULES, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(candidate) ? candidate : null
}

function main() {
  const nodeExe = pickNode()
  if (!nodeExe || !existsSync(nodeExe)) {
    console.error('[U-DSH] 未找到配套 Node 运行时：' + nodeExe)
    process.exit(1)
  }
  const entry = pickDshEntry()
  if (!entry) {
    console.error('[U-DSH] 未找到 DeepSeek Harness 内核（node_modules/@deepseek-ai/dsh）')
    process.exit(1)
  }
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch {}

  const args = [entry, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open']
  const env = Object.assign({}, process.env, { DSH_HOME: DATA_DIR })

  console.log('[U-DSH] 启动 DeepSeek Harness Web 内核…')
  const child = spawn(nodeExe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

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
