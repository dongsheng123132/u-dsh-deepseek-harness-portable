import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveWindowsHiddenConsoleLauncher } from '../src/dsh-service.js'

if (process.platform !== 'win32') {
  console.log('windows hidden-console test: skipped on non-Windows')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcher = process.env.WINDOWS_HIDDEN_CONSOLE_LAUNCHER
  ?? resolveWindowsHiddenConsoleLauncher()
// 这个脚本以前 import 的 resolveWindowsNodeExecutable 在 src/dsh-service.js 里已不存在
// （重构成 resolveWindowsHiddenConsoleLauncher / resolveWindowsPickerPatch 后遗留），
// 直接让 CI 报 ERR_MODULE_NOT_FOUND。这里改为「显式指定 / 当前 node」。
const nodeExecutable = process.env.WINDOWS_DSH_NODE ?? process.execPath
const visibleLauncher = path.join(os.tmpdir(), 'deepseek-harness-visible-console.exe')
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-hidden-console-'))
const powershellScript = path.join(temporaryRoot, 'inspect-console.ps1')
const aclWorkspace = path.join(temporaryRoot, 'acl-workspace')
const aclTempRoot = path.join(temporaryRoot, 'acl-temp')
const aclRunner = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-sandbox-windows-acl',
  'lib',
  'runner.js',
)

function readPeSubsystem(executablePath) {
  const bytes = readFileSync(executablePath)
  const peOffset = bytes.readUInt32LE(0x3c)
  if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    throw new Error(`${executablePath} is not a PE executable`)
  }
  const optionalHeaderOffset = peOffset + 24
  return bytes.readUInt16LE(optionalHeaderOffset + 68)
}

writeFileSync(powershellScript, `
$source = @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleInspector {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);
}
'@
Add-Type -TypeDefinition $source
$window = [ConsoleInspector]::GetConsoleWindow()
if ($window -eq [IntPtr]::Zero) {
  Write-Output "NO_CONSOLE"
} else {
  Write-Output ("HAS_CONSOLE_VISIBLE=" + [ConsoleInspector]::IsWindowVisible($window))
}
`, 'utf8')

const nodeScript = `
const { spawnSync } = require('node:child_process')
const result = spawnSync(
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', ${JSON.stringify(powershellScript)}],
  { encoding: 'utf8' },
)
process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''))
process.exitCode = result.status ?? 1
`

try {
  if (readPeSubsystem(nodeExecutable) !== 3) {
    throw new Error('dsh-node.exe must use the Windows Console subsystem')
  }

  const baseline = spawnSync(visibleLauncher, [process.execPath, '-e', nodeScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const baselineOutput = `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`.trim()

  if (baseline.error) throw baseline.error
  if (baseline.status !== 0) {
    throw new Error(`baseline launcher exited with ${String(baseline.status)}: ${baselineOutput}`)
  }
  if (!baselineOutput.includes('HAS_CONSOLE_VISIBLE=True')) {
    throw new Error(`baseline did not reproduce the visible PowerShell console: ${baselineOutput}`)
  }

  const result = spawnSync(launcher, [nodeExecutable, '-e', nodeScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`launcher exited with ${String(result.status)}: ${output}`)
  }
  if (!output.includes('HAS_CONSOLE_VISIBLE=False')) {
    throw new Error(`expected PowerShell to inherit a hidden console, got: ${output}`)
  }

  mkdirSync(aclWorkspace)
  mkdirSync(aclTempRoot)
  const aclScript = `
const { spawnSync } = require('node:child_process')
const result = spawnSync(
  process.execPath,
  [
    ${JSON.stringify(aclRunner)},
    '--workspace', ${JSON.stringify(aclWorkspace)},
    '--temp', ${JSON.stringify(aclTempRoot)},
    '--mode', 'read-only',
    '--',
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-Command', 'Write-Output ACL_POWERSHELL_OK',
  ],
  { encoding: 'utf8' },
)
process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''))
process.exitCode = result.status ?? 1
`
  const aclResult = spawnSync(launcher, [nodeExecutable, '-e', aclScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const aclOutput = `${aclResult.stdout ?? ''}${aclResult.stderr ?? ''}`.trim()
  if (aclResult.error) throw aclResult.error
  if (aclResult.status !== 0 || !aclOutput.includes('ACL_POWERSHELL_OK')) {
    throw new Error(
      `Windows ACL sandbox could not start PowerShell (status ${String(aclResult.status)}): ${aclOutput}`,
    )
  }

  console.log(
    `windows console test: subsystem=console, baseline=${baselineOutput}, fixed=${output}, acl=${aclOutput}`,
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
