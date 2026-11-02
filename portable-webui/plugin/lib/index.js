/**
 * 虾盘云设备钱包 · host 半边。
 * 纯 UI 插件：host 侧不需要任何行为，留一个空的 apply 让它在 cordis 里被挂载；
 * 浏览器半边在 exports["./client"]，由 package.json 的 dsh.client 声明发现。
 */
export function apply() {}
