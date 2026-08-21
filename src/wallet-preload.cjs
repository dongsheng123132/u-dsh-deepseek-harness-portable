const { contextBridge, ipcRenderer } = require('electron')

function action(actionId, input = {}) {
  return ipcRenderer.invoke('action-parity:call', { actionId, input }).then((envelope) => envelope?.ok
    ? { ok: true, value: envelope.result }
    : { ok: false, error: envelope?.error?.message || '操作失败' })
}

contextBridge.exposeInMainWorld('uDshWallet', {
  status: (refreshBalance = false) => action('wallet.status', { refreshBalance }),
  retry: () => action('wallet.ensure'),
  copyKey: () => action('wallet.key.copy'),
  pasteKey: () => ipcRenderer.invoke('wallet:paste-key'),
  recharge: () => ipcRenderer.invoke('wallet:open-recharge'),
  rotate: () => action('wallet.key.rotate'),
  adopt: (apiKey) => action('wallet.key.adopt', { apiKey }),
  resetLocal: () => action('wallet.reset_local'),
  kernelStatus: () => action('kernel.status'),
  checkKernelUpdates: () => action('kernel.check_updates'),
})
