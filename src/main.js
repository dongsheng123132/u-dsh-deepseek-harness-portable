import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron'
import { attachElectronIpc } from 'action-parity-sdk/electron'
import { buildActionRegistry } from './action-core.js'
import { startDshService } from './dsh-service.js'
import { createDeviceWallet, createFileWalletStore } from './device-wallet.js'
import { createDshConfigManager, XIAPAN_CREDENTIAL_REF } from './dsh-config.js'
import { createKernelManager } from './kernel-manager.js'
import { applyMacTitleBarStyle } from './mac-titlebar.js'
import { preparePortablePaths, resolvePortablePaths } from './portable-paths.js'
import { loadRuntimeChannel } from './runtime-channel.js'
import { resolveUclawEndpoints } from './uclaw-endpoints.js'
import { createWindowOptions } from './window-options.js'
import { createTrayMenuTemplate, shouldHideWindowOnClose } from './window-lifecycle.js'

const APP_NAME = 'U-DSH'
const STARTUP_PAGE = fileURLToPath(new URL('./startup.html', import.meta.url))
const WALLET_PAGE = fileURLToPath(new URL('./wallet.html', import.meta.url))
const WALLET_PRELOAD = fileURLToPath(new URL('./wallet-preload.cjs', import.meta.url))
const TRAY_ICON = fileURLToPath(new URL('../assets/tray.png', import.meta.url))
const TRAY_TEMPLATE_ICON = fileURLToPath(new URL('../assets/trayTemplate.png', import.meta.url))

const paths = preparePortablePaths(resolvePortablePaths({ isPackaged: app.isPackaged }))
const runtimeChannel = loadRuntimeChannel()

app.setName(APP_NAME)
app.setPath('userData', paths.electronDataDir)

let mainWindow
let walletWindow
let wallet
let kernel
let actionRegistry
let service
let serviceUrl
let tray
let trayAvailable = false
let isQuitting = false

function resultOf(action) {
  return Promise.resolve()
    .then(action)
    .then((value) => ({ ok: true, value }))
    .catch((error) => ({ ok: false, error: error?.message || String(error) }))
}

function installEditableContextMenu(targetWindow) {
  targetWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ]).popup({ window: targetWindow })
  })
}

async function showWalletWindow() {
  if (walletWindow && !walletWindow.isDestroyed()) {
    walletWindow.show()
    walletWindow.focus()
    return
  }
  walletWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 520,
    minHeight: 620,
    show: false,
    title: 'U-DSH 设备钱包',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111827' : '#f5f7fb',
    webPreferences: {
      preload: WALLET_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  walletWindow.setMenu(null)
  installEditableContextMenu(walletWindow)
  walletWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  walletWindow.once('ready-to-show', () => walletWindow?.show())
  walletWindow.on('closed', () => { walletWindow = undefined })
  await walletWindow.loadFile(WALLET_PAGE)
}

function registerWalletIpc() {
  ipcMain.handle('wallet:paste-key', () => resultOf(() => clipboard.readText()))
  ipcMain.handle('wallet:open-recharge', () => resultOf(async () => {
    await shell.openExternal(await wallet.rechargeUrl())
    return { message: '已打开充值页面' }
  }))
  attachElectronIpc(ipcMain, actionRegistry, {
    surface: 'gui',
    authorizeSender(event) {
      return Boolean(walletWindow && !walletWindow.isDestroyed() && event?.sender?.id === walletWindow.webContents.id)
    },
    async confirm({ action }) {
      const answer = await dialog.showMessageBox(walletWindow, {
        type: 'warning',
        buttons: ['取消', action.title],
        defaultId: 0,
        cancelId: 0,
        title: action.title,
        message: action.title,
        detail: action.description,
      })
      return answer.response === 1
    },
  })
}

async function showMainWindow() {
  if (!mainWindow) {
    await createWindow()
    if (serviceUrl) await mainWindow?.loadURL(serviceUrl)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    ...createWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    title: APP_NAME,
  })
  if (process.platform === 'win32') {
    mainWindow.setMenu(null)
    mainWindow.setMenuBarVisibility(false)
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (currentUrl && new URL(url).origin !== new URL(currentUrl).origin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') void applyMacTitleBarStyle(mainWindow.webContents)
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!shouldHideWindowOnClose(isQuitting, trayAvailable)) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  return mainWindow.loadFile(STARTUP_PAGE)
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(process.platform === 'darwin' ? TRAY_TEMPLATE_ICON : TRAY_ICON)
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    locale: app.getLocale(),
    showWindow: () => void showMainWindow(),
    hideWindow: () => mainWindow?.hide(),
    openWallet: () => void showWalletWindow(),
    quit: () => {
      isQuitting = true
      app.quit()
    },
  })))
  tray.on('click', () => void showMainWindow())
  trayAvailable = true
}

async function setStartupStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    await mainWindow.webContents.executeJavaScript(`window.udshSetStatus?.(${JSON.stringify(message)})`)
  } catch {
    // 启动页切走或窗口关闭时，不让进度文案影响内核启动。
  }
}

function kernelProgress(value) {
  if (value.phase === 'downloading-node') {
    const percentage = value.total > 0 ? ` ${Math.floor(value.received / value.total * 100)}%` : ''
    void setStartupStatus(`首次准备本机 Node 运行环境${percentage}`)
  } else if (value.phase === 'extracting-node') {
    void setStartupStatus('正在把 Node 运行环境解压到本机缓存…')
  } else if (value.phase === 'installing-dsh') {
    void setStartupStatus(`正在安装官方 DSH ${value.version} 到本机缓存…`)
  } else if (value.phase === 'installing-dsh-peers') {
    void setStartupStatus(`正在补齐 DSH ${value.version} 的 ${value.count} 个运行依赖…`)
  }
}

async function startResolvedKernel(resolved, environment) {
  const candidate = startDshService({
    electronExecutable: process.execPath,
    entry: resolved.entry,
    nodeExecutable: resolved.nodeExecutable,
    cwd: paths.dataDir,
    environment,
  })
  try {
    const url = await candidate.ready
    return { service: candidate, serviceUrl: url, resolved }
  } catch (error) {
    candidate.stop()
    throw error
  }
}

async function startKernelWithFallback(target, previous, environment) {
  const installed = await kernel.listInstalled()
  const versions = [target.version, previous, ...installed.map(({ version }) => version)]
    .filter((version, index, all) => version && all.indexOf(version) === index)
  const failures = []
  for (const version of versions) {
    try {
      const resolved = version === target.version ? target : await kernel.resolveDsh(version)
      await setStartupStatus(`正在启动 DSH ${version}…`)
      return await startResolvedKernel(resolved, environment)
    } catch (error) {
      failures.push(`${version}: ${error?.message || error}`)
    }
  }
  throw new Error(`没有可启动的 DSH 内核。\n${failures.join('\n')}`)
}

async function launch() {
  const startupReady = createWindow()
  await startupReady
  try {
    createTray()
  } catch (error) {
    console.warn(`System tray is unavailable: ${error?.message || error}`)
  }

  const endpoints = await resolveUclawEndpoints()
  const dshConfig = createDshConfigManager({ dshHome: paths.dshHome, endpoints })
  wallet = createDeviceWallet({
    store: createFileWalletStore(paths.walletFile),
    endpoints,
    applyKey: dshConfig.applyKey,
  })
  kernel = createKernelManager({ paths, channel: runtimeChannel })
  actionRegistry = buildActionRegistry({
    wallet,
    kernel,
    async copyCurrentKey() {
      const apiKey = await wallet.currentApiKey()
      if (!apiKey) throw new Error('当前没有设备钱包')
      clipboard.writeText(apiKey)
    },
  })
  registerWalletIpc()

  const walletReady = wallet.ensure()
  const kernelReady = kernel.ensure(kernelProgress)

  const environment = {
    ...process.env,
    NODE_OPTIONS: '',
    DSH_HOME: paths.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_DESKTOP: '1',
  }
  // C4：不允许宿主环境里同名变量盖过设备钱包同步到 .credentials.yaml 的值。
  delete environment[XIAPAN_CREDENTIAL_REF]

  try {
    await setStartupStatus('正在准备设备钱包和本机内核…')
    const [{ target, previous }] = await Promise.all([kernelReady, walletReady])
    const started = await startKernelWithFallback(target, previous, environment)
    service = started.service
    serviceUrl = started.serviceUrl
    await kernel.activate(started.resolved.version)
    await mainWindow?.loadURL(serviceUrl)
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 启动失败`,
      message: 'DeepSeek Harness 本地服务未能启动。',
      detail: error?.message || String(error),
    })
    app.quit()
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => { void showMainWindow() })
  app.whenReady().then(launch)
}

app.on('activate', () => { void showMainWindow() })
app.on('window-all-closed', () => {
  if (isQuitting || (!trayAvailable && process.platform !== 'darwin')) app.quit()
})
app.on('before-quit', () => {
  isQuitting = true
  service?.stop()
})
