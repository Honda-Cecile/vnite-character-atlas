# 1.1.0

这个目录是这个版本的全部产物，**不要手动改内容**，要改就改源码后重新 `npm run release`。

| 文件 | 用途 |
| --- | --- |
| `character-atlas-1.1.0.vnpkg` | 安装包。Vnite 里装的就是它；上传到 GitHub Release 的附件也是它 |
| `RELEASE_NOTES.md` | 冻结的发布说明（当时那份，不会随源码变化）。GitHub Release 正文用这份 |
| `CHANGELOG.md` | 这一版的更新条目 |
| `meta.json` | 版本 / 打包时间 / git commit / 大小 / sha256 |
| `SHA256SUMS.txt` | 校验和 |
| `publish.cmd` | **双击发布**：commit 不在 GitHub 上就先推 tag，再建 Release、传包、回读确认 |
| `1-打开发布页.url` | 备选：双击打开预填好 tag 与标题的 GitHub 新建 Release 页 |
| `2-复制发布说明.cmd` | 备选：双击把 `RELEASE_NOTES.md` 复制进剪贴板，网页里 Ctrl+V |

## 双击 publish.cmd

一步做完：确认 commit 在 GitHub（不在就 `git push v1.1.0`，**只推 tag，不动 main**）→ 校验包（大小 / sha256 / 包内版本）→ 建 Release（非 draft / 非 prerelease，正文取冻结的 `RELEASE_NOTES.md`）→ 上传附件（同名先删再传）→ 回读确认并打印下载地址。

可重复运行，不想要正式发布就先演练：

```
publish.cmd --dry-run     只打印会做什么，不联网改任何东西
publish.cmd --no-push     不推 tag，只上传（tag 已在远端时用）
publish.cmd --main        顺手把 main 也推上去（默认不推）
```

token 用一次就够了（仓库根的 `set-token.cmd` 会读剪贴板写入 `.secrets/github-token` 并验证写权限）。

## 手动发（不想用脚本）

GitHub → Releases → Draft a new release → **Choose a tag** 选已存在的 `v1.1.0`（**不要**新建 tag）→ 正文粘贴 `RELEASE_NOTES.md` → 附件选 `character-atlas-1.1.0.vnpkg` → 不要勾 prerelease、不要存 draft。
