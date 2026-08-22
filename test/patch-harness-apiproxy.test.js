import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeWindowsOpenCommand,
  patchWindowsPathOpener,
} from '../scripts/patch-harness-apiproxy.mjs'

const ORIGINAL = `async function openWindowsPath(path, signal, run) {
\tawait run("powershell.exe", [
\t\t"-NoProfile",
\t\t"-Command",
\t\t\`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`
\t], signal);
}`

test('Windows path opener uses a UTF-16LE encoded PowerShell command', () => {
  const encoded = encodeWindowsOpenCommand("C:\\项目\\Steven's file.txt")
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf16le'),
    "Invoke-Item -LiteralPath 'C:\\项目\\Steven''s file.txt'",
  )
})

test('dependency patch replaces exactly the pinned Windows path opener', () => {
  const patched = patchWindowsPathOpener(`before\n${ORIGINAL}\nafter`)
  assert.match(patched, /Buffer\.from\(command, "utf16le"\)/)
  assert.match(patched, /"-EncodedCommand"/)
  assert.doesNotMatch(patched, /"-Command",/)
  assert.equal(patchWindowsPathOpener(patched), patched)
})

test('dependency patch fails loudly when upstream implementation drifts', () => {
  assert.throws(
    () => patchWindowsPathOpener('async function openWindowsPath() {}'),
    /Expected exactly one/,
  )
})
