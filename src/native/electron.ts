/**
 * 主进程里的 electron 句柄。
 *
 * Vnite 用 `require()` 直接加载插件模块（没有 vm 沙箱），所以插件能拿到 electron。
 * 这里把「拿 electron」抽成独立模块，让**所有人都能用**它：
 *  - 原生标签页注入（injector）
 *  - 导出/导入的系统文件对话框、打开缓存目录（index）
 *
 * 这样即使配置里关掉了原生标签页（`nativeTab=false`，注入器压根没创建），
 * 导出/导入也照样弹得出对话框 —— 之前它们挂在注入器上，关掉标签页就一起废了。
 */

export interface ElectronHost {
  app?: any
  BrowserWindow?: any
  shell?: any
  dialog?: any
}

/** 非 Electron 环境（例如本仓库的 Node 冒烟测试）返回 null，调用方自己降级 */
export function loadElectron(): ElectronHost | null {
  if (!process.versions || !process.versions.electron) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as ElectronHost | undefined
    if (!electron) return null
    return electron
  } catch {
    return null
  }
}
