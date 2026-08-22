/**
 * 启动失败的人话翻译：把原始异常映射成「一句用户看得懂的话 + 一个能照做的动作」。
 * 原始信息保留在 detail 里，方便反馈排查；绝不让用户直面裸堆栈。
 */

const RULES = [
  {
    // DSH 每次启动要在 dsh-home 下建 NTFS junction，exFAT / FAT32 放不下（见 ROADMAP 既有决定）。
    pattern: /EISDIR|ensureSymlink|junction|symlink/i,
    summary: '数据盘的文件系统不支持 DSH 需要的目录链接（junction）。',
    action: '请把 U 盘 / 移动盘转换或格式化为 NTFS 后重新解压使用（exFAT、FAT32 都不行）。格式化前先备份盘上资料。',
  },
  {
    pattern: /ENOSPC|no space left|磁盘空间不足/i,
    summary: '磁盘空间不够了。',
    action: '清理出至少 1GB 可用空间（或换一个更大的盘）后重新启动。',
  },
  {
    pattern: /EADDRINUSE/i,
    summary: '本机端口被其他程序占用。',
    action: '关闭占用端口的程序，或重启电脑后再启动 U-DSH。',
  },
  {
    pattern: /EPERM|EACCES|operation not permitted|access is denied/i,
    summary: '没有足够的文件权限。',
    action: '确认盘没有写保护、文件没有被杀毒软件拦截；必要时右键「以管理员身份运行」。',
  },
  {
    pattern: /随包 Node 运行时缺失|发布包不完整/,
    summary: '发布包不完整，缺少随包内核文件。',
    action: '重新解压完整的发布包（解压时不要跳过或只拷贝部分文件），再启动。',
  },
  {
    pattern: /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|fetch failed/i,
    summary: '网络暂时不可用（启动本身不需要联网，这通常不影响使用）。',
    action: '如果界面没有正常出现，请检查代理 / 防火墙设置后重试。',
  },
]

export function describeStartupFailure(error) {
  const raw = (error?.message || String(error ?? '')).trim()
  const rule = RULES.find(({ pattern }) => pattern.test(raw))
  if (rule) return { summary: rule.summary, action: rule.action, detail: raw }
  return {
    summary: 'DeepSeek Harness 本地服务未能启动。',
    action: '重启一次试试；仍失败请把下面的详细信息反馈给我们。',
    detail: raw,
  }
}
