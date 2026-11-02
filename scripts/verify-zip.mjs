#!/usr/bin/env node
/**
 * 发布包体检：断言 zip 对 POSIX 解压友好。
 *
 *   node scripts/verify-zip.mjs dist/U-DSH-WebUI-Portable-0.4.2-win-mac.zip [--json] [--no-content]
 *
 * 为什么单独一个脚本：打包器的自检会在 CI 里跑，但发布资产可能是别人、别的时间、别的机器
 * 打出来的（历史上就有 .NET ZipFile 打的 win.zip 混进 release）。这个脚本能对任何 zip 当场
 * 判真伪，不依赖打包器「自认为对」。
 *
 * 断言（每条都对应一个真实会砸到用户的现象）：
 *   1. 条目名一律正斜杠（反斜杠会让部分解压器解出怪路径，macOS 上 .command 直接找不到）
 *   2. .command/.sh 条目 external_attr 高 16 位的执行位必须是 0o755（否则 macOS 双击 EACCES）
 *   3. .command/.sh 内容不能有 CR（`#!/bin/bash\r` → bad interpreter: /bin/bash^M）
 *   4. 目录条目以 / 结尾，条目名无绝对路径 / `..` / 非 NFC
 *   5. 非 ASCII 名字必须置 UTF-8 标志（否则 Windows 按 OEM 码页解出乱码）
 *   6. 内容 CRC32 / 长度与中央目录一致（包没坏）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { verifyZipFile } from './lib/zip-archive.mjs'

function parseArgs(argv) {
  const out = { files: [], json: false, content: true }
  for (const arg of argv) {
    if (arg === '--json') out.json = true
    else if (arg === '--no-content') out.content = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
    else out.files.push(arg)
  }
  return out
}

const heading = (result) => {
  const { entryCount, directoryCount, fileCount, executableCount } = result.summary
  return `${entryCount} 条目（${directoryCount} 目录 / ${fileCount} 文件），可执行 ${executableCount}`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.files.length === 0) {
    console.log('用法：node scripts/verify-zip.mjs <zip>... [--json] [--no-content]')
    process.exit(args.help ? 0 : 2)
  }

  const reports = []
  let failed = false
  for (const file of args.files) {
    const zipPath = path.resolve(file)
    let report
    try {
      const result = verifyZipFile(zipPath, args.content ? undefined : { withData: false })
      report = {
        file: zipPath,
        ok: result.ok,
        summary: result.summary,
        problems: result.problems,
      }
    } catch (error) {
      report = { file: zipPath, ok: false, summary: null, problems: [{ code: 'unreadable', entry: null, message: error.message }] }
    }
    reports.push(report)
    if (!report.ok) failed = true
    if (args.json) continue

    console.log(`verify-zip: ${path.basename(zipPath)}`)
    console.log(`  ${report.ok ? '✓ 通过' : '✗ 不合规'} —— ${report.summary ? heading(report) : '读不出中央目录'}`)
    for (const problem of report.problems.slice(0, 40)) {
      console.log(`  [${problem.code}] ${problem.entry ?? '<整个包>'} —— ${problem.message}`)
    }
    if (report.problems.length > 40) console.log(`  …… 另有 ${report.problems.length - 40} 条同类问题未列出`)
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: !failed, reports }, null, 2))
  }
  process.exit(failed ? 1 : 0)
}

main()
