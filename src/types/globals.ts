import type { IPluginAPI } from 'vnite-plugin-sdk'

declare global {
  // 便于调试：Vnite 加载插件后可从控制台拿到 API
  var vniteAPI: IPluginAPI | undefined
}

export {}
