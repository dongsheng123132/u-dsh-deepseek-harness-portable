export function shouldHideWindowOnClose(isQuitting, hasTray = true) {
  return !isQuitting && hasTray
}

export function createTrayMenuTemplate({
  locale = 'en',
  showWindow,
  hideWindow,
  openWallet,
  reportProblem,
  quit,
}) {
  const isChinese = locale.toLowerCase().startsWith('zh')

  return [
    {
      label: isChinese ? '打开 U-DSH Portable' : 'Open U-DSH Portable',
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
    // 出问题的时候界面往往已经不好使了，托盘是最后一条还能点的路。
    // 报告里带着日志和内核状态，省掉三轮来回问。
    {
      label: isChinese ? '报告问题…' : 'Report a problem…',
      click: reportProblem,
    },
    { type: 'separator' },
    {
      label: isChinese ? '退出' : 'Quit',
      click: quit,
    },
  ]
}
