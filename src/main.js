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
import { buildWalletEntryScript, isWalletOpenRequest, shouldAutoOpenWallet } from './first-run.js'
import { createKernelManager } from './kernel-manager.js'
import { createLogger } from './logger.js'
import { applyMacTitleBarStyle } from './mac-titlebar.js'
import { preparePortablePaths, resolvePortablePaths } from './portable-paths.js'
import { probeJunctionSupport } from './portable-preflight.js'
import { describeStartupFailure } from './startup-errors.js'
import { loadRuntimeChannel } from './runtime-channel.js'
import { resolveUclawEndpoints } from './uclaw-endpoints.js'
import { createWindowOptions } from './window-options.js'
import { createTrayMenuTemplate, shouldHideWindowOnClose } from './window-lifecycle.js'

const APP_NAME = 'U-DSH Portable'
const STARTUP_PAGE = fileURLToPath(new URL('./startup.html', import.meta.url))
const WALLET_PAGE = fileURLToPath(new URL('./wallet.html', import.meta.url))
const WALLET_PRELOAD = fileURLToPath(new URL('./wallet-preload.cjs', import.meta.url))
const TRAY_ICON = fileURLToPath(new URL('../assets/tray.png', import.meta.url))
const TRAY_TEMPLATE_ICON = fileURLToPath(new URL('../assets/trayTemplate.png', import.meta.url))

const paths = preparePortablePaths(resolvePortablePaths({ isPackaged: app.isPackaged }))
const runtimeChannel = loadRuntimeChannel()
// 静默降级必须在磁盘上留痕，否则远程支持时我们是瞎的。
const logger = createLogger(paths.logsDir)

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
    title: 'U-DSH Portable 设备钱包',
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
    // 注入进 DSH 界面的钱包入口走 udsh://wallet，拦下来开自己的钱包窗口，
    // 别丢给系统浏览器。
    if (isWalletOpenRequest(url)) {
      void showWalletWindow()
      return { action: 'deny' }
    }
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
    // 「开箱即有额度」是相对全部竞品的唯一结构性优势，不能只藏在系统托盘里。
    // 只注入到 DSH 服务页，启动页不需要。
    if (serviceUrl && mainWindow?.webContents.getURL()?.startsWith(serviceUrl)) {
      mainWindow.webContents
        .executeJavaScript(buildWalletEntryScript({ locale: app.getLocale() }))
        .catch((error) => logger.warn('[first-run] 钱包入口注入失败', error?.message))
    }
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

/**
 * 首启把钱包页主动递到用户面前 —— 但只在他确实需要动手时递：
 * 没钱包（离线首启）、有未完成的换 Key、或余额为 0。
 * 已充值或余额未知（离线没查到）就别打扰。
 */
async function presentWalletIfNeeded(walletState) {
  let status
  try {
    status = await wallet.status()
  } catch (error) {
    logger.warn('[first-run] 读钱包状态失败，按未就绪处理', error?.message)
    status = { available: Boolean(walletState?.apiKey), pending: false, balanceAvailable: null }
  }
  if (!shouldAutoOpenWallet(status)) return
  logger.info('[first-run] 钱包需要用户处理，主动打开钱包页')
  await showWalletWindow()
}

async function setStartupStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    await mainWindow.webContents.executeJavaScript(`window.udshSetStatus?.(${JSON.stringify(message)})`)
  } catch {
    // 启动页切走或窗口关闭时，不让进度文案影响内核启动。
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
    logger.warn(`System tray is unavailable: ${error?.message || error}`)
  }

  logger.info(`[launch] ${APP_NAME} 启动，数据目录 ${paths.dataDir}`)

  const endpoints = await resolveUclawEndpoints()
  const dshConfig = createDshConfigManager({ dshHome: paths.dshHome, endpoints })
  wallet = createDeviceWallet({
    store: createFileWalletStore(paths.walletFile, logger),
    endpoints,
    applyKey: dshConfig.applyKey,
    logger,
  })
  kernel = createKernelManager({ paths, channel: runtimeChannel })
  actionRegistry = buildActionRegistry({
    wallet,
    kernel,
    async openRecharge() {
      await shell.openExternal(await wallet.rechargeUrl())
    },
    async copyCurrentKey() {
      const apiKey = await wallet.currentApiKey()
      if (!apiKey) throw new Error('当前没有设备钱包')
      clipboard.writeText(apiKey)
    },
  })
  registerWalletIpc()

  const walletReady = wallet.ensure()
  // 内核已随包 vendor，ensure 是纯本地校验：无网络、无安装、毫秒级。
  const kernelReady = kernel.ensure()

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
    await setStartupStatus('正在检查数据盘…')
    // exFAT / FAT32 放不下 DSH 每次启动都要建的 junction。与其让 DSH 起到一半抛
    // 裸 EISDIR，不如在这里花几毫秒真探一次，直接告诉用户「换 NTFS」。
    const junction = await probeJunctionSupport(paths.dataDir)
    if (!junction.ok) {
      logger.error('[preflight] 数据盘不支持 junction', junction.error?.message)
      throw junction.error ?? new Error('数据盘不支持 junction')
    }

    await setStartupStatus('正在准备设备钱包和随包内核…')
    const [{ target, previous }, walletState] = await Promise.all([kernelReady, walletReady])

    // wallet.ensure() 内部把失败全吞了（C1：断网不能挡住 DSH 启动）。降级本身是对的，
    // 但不能是静默的 —— 否则用户一路走到对话框才撞 `API key is invalid`。
    if (!walletState?.configured) {
      logger.warn('[launch] 设备钱包未就绪，DSH 仍继续启动；将主动递上钱包页')
    } else {
      logger.info(`[launch] 设备钱包已就绪 ${walletState.walletId || '(无 walletId)'}`)
    }

    const started = await startKernelWithFallback(target, previous, environment)
    service = started.service
    serviceUrl = started.serviceUrl
    await kernel.activate(started.resolved.version)
    await mainWindow?.loadURL(serviceUrl)
    await presentWalletIfNeeded(walletState)
  } catch (error) {
    const { summary, action, detail } = describeStartupFailure(error)
    logger.error('[launch] 启动失败', detail)
    await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 启动失败`,
      message: summary,
      detail: `${action}\n\n详细信息：${detail}${logger.file ? `\n日志：${logger.file}` : ''}`,
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
