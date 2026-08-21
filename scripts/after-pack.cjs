const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    const product = context.packager.appInfo.productFilename
    const launcher = [
      '@echo off',
      'setlocal',
      'set "UDSH_PORTABLE_ROOT=%~dp0"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"%~dp0${product}.exe" "%~dp0resources\\app\\src\\cli.js" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
    writeFileSync(path.join(context.appOutDir, 'U-DSH-CLI.cmd'), launcher)
    return
  }

  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit',
  })
}
