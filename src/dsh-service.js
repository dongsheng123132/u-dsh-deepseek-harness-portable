import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)\b/m

export function unpackedPath(path) {
  return path.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
}

export function extractReadyUrl(output) {
  return READY_PATTERN.exec(output)?.[1]
}

export function resolveWindowsPickerPatch() {
  return fileURLToPath(new URL('../config/windows-directory-picker.patch.yml', import.meta.url))
}

export function resolveWindowsHiddenConsoleLauncher() {
  return fileURLToPath(new URL('../assets/windows-hidden-console.exe', import.meta.url))
}

export function buildDshArgs(entry, {
  platform = process.platform,
  windowsPickerPatch = resolveWindowsPickerPatch(),
} = {}) {
  return [
    '--expose-internals',
    entry,
    '--profile',
    'web',
    ...(platform === 'win32' ? ['--patch', windowsPickerPatch] : []),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]
}

export function buildDshCommand({
  electronExecutable,
  entry,
  nodeExecutable,
  platform = process.platform,
  windowsLauncher = resolveWindowsHiddenConsoleLauncher(),
} = {}) {
  if (!entry) throw new Error('entry is required')

  const args = buildDshArgs(entry, { platform })
  if (platform === 'win32') {
    if (!nodeExecutable) throw new Error('nodeExecutable is required on Windows')
    return windowsLauncher && existsSync(windowsLauncher)
      ? { command: windowsLauncher, args: [nodeExecutable, ...args] }
      : { command: nodeExecutable, args }
  }
  if (nodeExecutable) return { command: nodeExecutable, args }
  if (!electronExecutable) throw new Error('electronExecutable is required without a Node runtime')
  return { command: electronExecutable, args }
}

export function startDshService({
  electronExecutable,
  entry,
  nodeExecutable,
  environment = process.env,
  platform = process.platform,
  timeoutMs = 60_000,
  cwd,
  windowsLauncher = resolveWindowsHiddenConsoleLauncher(),
} = {}) {
  const { command, args } = buildDshCommand({
    electronExecutable,
    entry,
    nodeExecutable,
    platform,
    windowsLauncher,
  })

  const child = spawn(command, args, {
    env: {
      ...environment,
      ...(platform === 'win32' ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    },
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let settled = false

  const ready = new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const inspect = (chunk) => {
      output += chunk.toString()
      const url = extractReadyUrl(output)
      if (url) finish(resolve, url)
    }

    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      finish(
        reject,
        new Error(`DeepSeek Harness stopped before it was ready (code ${String(code)}, signal ${String(signal)}).\n${output}`),
      )
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`DeepSeek Harness did not become ready within ${timeoutMs}ms.\n${output}`))
    }, timeoutMs)
  })

  const stop = () => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  }

  return { child, ready, stop }
}
