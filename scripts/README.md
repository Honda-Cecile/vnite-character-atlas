# 探针脚本

都不需要开 Vnite，直接在仓库根目录 `node scripts/<name>.js`。

## 常用（发布前跑这几个）

| 脚本 | 需要网络 | 覆盖内容 |
| --- | --- | --- |
| `smoke.js` | ✅ | 真实 API 冒烟：`activate` → IPC 注册 → 刮一部作品 → 缓存命中 → `deactivate` |
| `probe-native.js` | ❌ | 注入逻辑：标签顺序 / 单排布局 / 面板可见性 / 隐藏概览后的取名 / 立绘弹窗 / 路由身份 / 重复面板清理 / 下划线恢复 |
| `probe-ui.js` | ❌ | UI 行为：搜索、按标签筛选、设置项注入、单个高亮、残留面板、卡片排版、切作品清搜索 |
| `probe-edit.js` | ❌ | 右键菜单 → 编辑弹窗 → 提交 → 删除 → 重新下发卡片数 |
| `probe-overrides.js` | ❌ | 个人修正层与 `autoOnLaunch` 开关（mock PluginDB，离线） |
| `verify-package.js` | ❌ | 校验 `dist/*.vnpkg`：包内文件、13 项配置的 `controlType`、导出符号、`BOOTSTRAP_SOURCE` 长度 |

## 按需

| 脚本 | 说明 |
| --- | --- |
| `probe-dedupe.js` | 真实 API：同名重复条目合并（用 KunGalgame #886 / #1626 两作交叉验证） |
| `probe-vndb.js` | VNDB 兜底链路 |
| `probe-conflict.js` | PluginDB 并发读写的 409 冲突重试 |
| `probe-double-activate.js` | `activate()` 被重复调用时的幂等性 |
| `probe-real-panel.js` | 真实数据 → `NativeTabInjector` 快照 → 无头 Chrome 截图（`.tmp/real/`） |
| `shoot.js` / `shoot-editor.js` | 生成 `.tmp/` 下的 UI 截图，用于目检 |
| `gen-icon.js` | 重新生成 `icon.png` |
| `probe-trace.js` / `probe-refs*.mjs` / `probe-user.js` / `dump-user.js` | 开发期一次性诊断脚本（保留备查，不参与 CI） |

> 注入脚本是以 `nativeBootstrap.toString()` 的形式打进 `dist/index.js` 的，所以**改完 `src/` 必须先 `npm run build`**，探针读的始终是 `dist/index.js`。
