#!/usr/bin/env node
/**
 * 查看 / 清理本机的 U-DSH 引擎缓存。
 *
 * 引擎是**可重建的本机缓存**：删了不影响 U 盘里的数据（配置/会话/钱包都在盘上），
 * 下次启动会自动重新解包。换机器、要腾空间、或者怀疑引擎装坏了，用这个。
 *
 * 用法：
 *   node scripts/clear-engine.mjs                      # 列出已安装的引擎版本与占用
 *   node scripts/clear-engine.mjs --all --yes           # 全部删除
 *   node scripts/clear-engine.mjs --version 0.2.0-rc.2 --yes   # 只删某个版本
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const out = { all: false, yes: false, version: null, keep: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') out.all = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--keep') out.keep = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

function engineBase() {
  const override = process.env.UDSH_ENGINE_HOST_ROOT?.trim()
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(local, 'U-DSH', 'engine')
  }
  return path.join(os.homedir(), 'Library', 'Caches', 'U-DSH', 'engine')
}

function dirSize(p) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch {} }
    }
  }
  try { walk(p) } catch {}
  return total
}

const mb = (b) => `${(b / 1024 ** 2).toFixed(0)} MB`

function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = engineBase()
  if (args.help) {
    console.log('用法：node scripts/clear-engine.mjs [--all --yes | --version <版本> --yes] [--keep <数量>]')
    return
  }
  if (!existsSync(base)) {
    console.log(`本机还没有安装过引擎：${base}`)
    return
  }
  const versions = readdirSync(base)
    .filter((name) => !name.includes('.installing') && !name.endsWith('.lock'))
    .map((name) => ({ name, dir: path.join(base, name), size: dirSize(path.join(base, name)) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  console.log(`引擎缓存目录：${base}`)
  for (const v of versions) console.log(`  ${v.name.padEnd(16)} ${mb(v.size)}`)
  console.log(`合计：${mb(versions.reduce((sum, v) => sum + v.size, 0))}`)
  console.log('（删掉不影响 U 盘数据；下次启动会自动重新解包）')

  let targets = []
  if (args.all) targets = versions
  else if (args.version) targets = versions.filter((v) => v.name === args.version)
  else if (args.keep) targets = versions.slice(0, Math.max(0, versions.length - Number(args.keep)))
  if (targets.length === 0) {
    if (args.all || args.version || args.keep) console.log('没有匹配到要删除的版本')
    else console.log('\n加 --all --yes 删除全部，或 --version <版本> --yes 删指定版本')
    return
  }
  if (!args.yes) {
    console.log(`\n将删除 ${targets.length} 个版本：${targets.map((t) => t.name).join(', ')}（加 --yes 确认）`)
    return
  }
  for (const target of targets) {
    rmSync(target.dir, { recursive: true, force: true })
    console.log(`已删除 ${target.name}`)
  }
}

try { main() } catch (error) {
  console.error(`clear-engine: ${error.message}`)
  process.exit(1)
}
