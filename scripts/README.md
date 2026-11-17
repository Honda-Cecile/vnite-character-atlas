# 脚本索引

都不需要开 Vnite，直接在仓库根目录 `node scripts/<name>.js`。

## 发布链路（手动也只要这几步）

| 脚本 | 作用 |
| --- | --- |
| `stage-release.js` | `npm run release` 用它：build + pack → 写 `releases/v<版本>/`（含冻结说明、meta、sha256、源码快照）→ 刷新累积 CHANGELOG → 镜像到仓库外。旧版本用 `--version=x.y.z` 补归档 |
| `backup-source.js` | 每个版本一份源码快照 `source-v<版本>.zip`（`git archive <tag>`）；`publish` 前自动补，也可 `npm run backup:source` 手跑 |
| `publish.js` | 一条链路发布：确认 commit 在 GitHub（不在就先推这个 tag）→ 补源码快照 → 建 Release → 传包 → 回读确认。`--dry-run` / `--no-push` / `--main` |
| `upload-release.js` | 只做「建 Release + 传附件」，不碰 git（调试用，`npm run upload`） |
| `check-releases.js` | 审计 `releases/`：目录名 = 包内版本 = tag 里的 `package.json` 版本 = sha256 = 源码快照（`npm run check:releases`） |
| `verify-package.js` | 校验 `.vnpkg`：包内文件、14 项配置的 `controlType`、导出符号、`BOOTSTRAP_SOURCE` 长度 |
| `set-token.js` | 读剪贴板里的 GitHub token → 写 `.secrets/github-token`（已被 `.gitignore` 排除）并现场验写权限 |

## 回归探针（发布前跑）

| 脚本 | 需要网络 | 覆盖内容 |
| --- | --- | --- |
| `smoke.js` | ✅ | 真实 API 冒烟：`activate` → IPC 注册 → 刮一部作品 → 缓存命中 → 导出/导入 → `deactivate` |
| `probe-native.js` | ❌ | 注入逻辑：标签顺序 / 单排布局 / 面板可见性 / 隐藏概览后的取名 / 立绘弹窗 / 路由身份 / 重复面板清理 / 下划线恢复 |
| `probe-ui.js` | ❌ | UI 行为：搜索、按标签筛选、设置项注入、单个高亮、残留面板、卡片排版、切作品清搜索 |
| `probe-edit.js` | ❌ | 右键菜单 → 编辑弹窗 → 提交 → 删除 → 重新下发卡片数 |
| `probe-overrides.js` | ❌ | 个人修正层与 `autoOnLaunch` 开关（mock PluginDB，离线） |
| `probe-traits.js` | ❌ | 标签档位：`spoiler=major`、去重取最低档、`is_lie` 丢弃、原名参与匹配 |
| `probe-spoiler.js` | ❌ | 剧透折叠的 DOM 行为：卡片不含剧透标签、弹窗默认收起、展开/收起 |
| `probe-auth.js` | ❌ | API Key 失效时降级匿名访问、配置热重读 |
| `probe-paths.js` | ❌ | 图片缓存目录判定：便携 / 安装版 / 无 Electron |
| `probe-conflict.js` | ❌ | PluginDB 并发读写的 409 冲突重试 |
| `probe-double-activate.js` | ❌ | `activate()` 重复调用时的幂等性（不重复注册 IPC） |
| `probe-dedupe.js` | ✅ | 同名重复条目合并（KunGalgame #886 / #1626 交叉验证） |
| `probe-vndb.js` | ✅ | KunGalgame 未收录时落 VNDB 兜底 |

## 目检 / 出图（不联网，截图落在 `.tmp/`）

| 脚本 | 说明 |
| --- | --- |
| `preview-scrollbars.js` | 面板列表 / 编辑弹窗 / textarea 的滚动条占宽实测（CSS 取自 `dist/index.js` 注入的那份） |
| `preview-settings.js` | 「人物数据」设置行与原生行的外观对照 |
| `probe-real-panel.js` | 真实数据 → `NativeTabInjector` 快照 → 无头 Chrome 截图（`.tmp/real/`） |
| `gen-icon.js` | 重新生成 `icon.png`（纯 Node 编码 PNG，不依赖图像库） |

> 注入脚本是以 `nativeBootstrap.toString()` 的形式打进 `dist/index.js` 的，所以**改完 `src/` 必须先 `npm run build`**，探针读的始终是 `dist/index.js`。
