#!/usr/bin/env node
/**
 * 备份 U 盘上的 DSH 数据目录（data/dsh-home）。
 *
 * 为什么需要它：数据目录在 exFAT U 盘上，exFAT 没有 journaling，拔盘/掉电/盘本身损坏都可能
 * 让会话或配置写坏。引擎坏了能重装，用户数据坏了没地方找——所以给一条「一键备份」的路。
 *
 * 用法：
 *   node scripts/backup-dsh-home.mjs --root <便携包根>                 # 备份到 <根>/backups/
 *   node scripts/backup-dsh-home.mjs --root <便携包根> --to <目录>      # 备份到本机或网盘目录
 *   node scripts/backup-dsh-home.mjs --root <便携包根> --keep 10        # 保留最近 10 份（默认 5）
 *   node scripts/backup-dsh-home.mjs --list --root <便携包根>           # 看已有备份
 *
 * 备份内容是 zip（系统 tar -a 生成，Windows/macOS 都能开），文件名带时间戳。
 * 注意：**同一支 U 盘上的备份不能防盘损坏/丢失**，重要数据请用 --to 备份到本机或别的介质。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = { root: null, to: null, keep: 5, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') out.root = argv[++i]
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--keep') out.keep = Number(argv[++i])
    else if (a === '--list') out.list = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const mb = (b) => `${(b / 1024 ** 2).toFixed(1)} MB`

function listBackups(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith('dsh-home-') && n.endsWith('.zip'))
    .map((n) => ({ name: n, size: statSync(path.join(dir, n)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.root) {
    console.log('用法：node scripts/backup-dsh-home.mjs --root <便携包根> [--to <目录>] [--keep 5] [--list]')
    process.exit(args.help ? 0 : 2)
  }
  const root = path.resolve(args.root)
  const dataDir = path.join(root, 'data', 'dsh-home')
  if (!existsSync(dataDir)) {
    console.error(`backup: 没找到数据目录 ${dataDir}`)
    process.exit(2)
  }
  const destDir = path.resolve(args.to || path.join(root, 'backups'))

  if (args.list) {
    const items = listBackups(destDir)
    if (items.length === 0) console.log(`（${destDir} 里还没有备份）`)
    for (const item of items) console.log(`${item.name}  ${mb(item.size)}`)
    return
  }

  mkdirSync(destDir, { recursive: true })
  const zipPath = path.join(destDir, `dsh-home-${stamp()}.zip`)
  console.log(`备份 ${dataDir} → ${zipPath}`)
  // bsdtar 的 -a 按扩展名生成 zip；Windows 10+/macOS 自带。
  execFileSync('tar', ['-a', '-cf', zipPath, '-C', path.dirname(dataDir), path.basename(dataDir)], { stdio: 'inherit' })
  console.log(`完成：${mb(statSync(zipPath).size)}`)

  const items = listBackups(destDir)
  const extra = items.slice(0, Math.max(0, items.length - args.keep))
  for (const item of extra) {
    rmSync(path.join(destDir, item.name), { force: true })
    console.log(`清理旧备份：${item.name}`)
  }
  if (destDir.startsWith(root)) {
    console.log('提示：备份和原数据在同一支 U 盘上，防不了盘损坏或丢失；重要数据请用 --to 备份到本机或别的介质。')
  }
}

main()
