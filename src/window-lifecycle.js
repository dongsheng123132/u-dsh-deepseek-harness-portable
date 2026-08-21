export function shouldHideWindowOnClose(isQuitting, hasTray = true) {
  return !isQuitting && hasTray
}

export function createTrayMenuTemplate({
  locale = 'en',
  showWindow,
  hideWindow,
  openWallet,
  quit,
}) {
  const isChinese = locale.toLowerCase().startsWith('zh')

  return [
    {
      label: isChinese ? '打开 U-DSH' : 'Open U-DSH',
      click: showWindow,
    },
    {
      label: isChinese ? '设备钱包' : 'Device Wallet',
      click: openWallet,
    },
    {
      label: isChinese ? '隐藏窗口' : 'Hide Window',
      click: hideWindow,
    },
    { type: 'separator' },
    {
      label: isChinese ? '退出' : 'Quit',
      click: quit,
    },
  ]
}
