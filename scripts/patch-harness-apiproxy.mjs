import { readFileSync, writeFileSync } from 'node:fs'

/**
 * DSH 官方 @deepseek-ai/dsh-host-apiproxy 在 Windows 上用
 * `powershell.exe -Command "Invoke-Item -LiteralPath '<path>'"` 打开文件/目录。
 * 命令字符串走 argv 明文传递，在中文 Windows / 含特殊字符的 U 盘路径上会被
 * PowerShell 参数重组阶段二次解释。改成 -EncodedCommand（UTF-16LE Base64）
 * 后命令原样送达，不再经过任何引号/编码解释层。
 * 该补丁在构建期由 prepare-vendor.mjs 施加到 vendor 出来的闭包上；
 * rc.7 上游仍是原始实现（2026-08 复核），上游改了实现会在这里 fail loudly。
 */

const ORIGINAL_WINDOWS_OPENER = `async function openWindowsPath(path, signal, run) {
\tawait run("powershell.exe", [
\t\t"-NoProfile",
\t\t"-Command",
\t\t\`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`
\t], signal);
}`

const PATCHED_WINDOWS_OPENER = `async function openWindowsPath(path, signal, run) {
\tconst command = \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`;
\tconst encodedCommand = Buffer.from(command, "utf16le").toString("base64");
\tawait run("powershell.exe", [
\t\t"-NoLogo",
\t\t"-NoProfile",
\t\t"-NonInteractive",
\t\t"-EncodedCommand",
\t\tencodedCommand
\t], signal);
}`

export function encodeWindowsOpenCommand(targetPath) {
  const literal = `'${targetPath.replaceAll("'", "''")}'`
  const command = `Invoke-Item -LiteralPath ${literal}`
  return Buffer.from(command, 'utf16le').toString('base64')
}

export function patchWindowsPathOpener(source) {
  if (source.includes(PATCHED_WINDOWS_OPENER)) return source
  const matches = source.split(ORIGINAL_WINDOWS_OPENER).length - 1
  if (matches !== 1) {
    throw new Error(`Expected exactly one DeepSeek Harness Windows path opener, found ${matches}`)
  }
  return source.replace(ORIGINAL_WINDOWS_OPENER, PATCHED_WINDOWS_OPENER)
}

/** 幂等：已打过补丁的文件重复调用不变。 */
export function prepareApiProxy(target) {
  const source = readFileSync(target, 'utf8')
  const patched = patchWindowsPathOpener(source)
  if (patched !== source) writeFileSync(target, patched)
  return patched !== source
}
