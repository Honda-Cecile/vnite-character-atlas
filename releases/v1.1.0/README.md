# 1.1.0

这个目录是这个版本的全部产物，**不要手动改内容**，要改就改源码后重新 `npm run release`。

| 文件 | 用途 |
| --- | --- |
| `character-atlas-1.1.0.vnpkg` | 安装包。Vnite 里装的就是它；上传到 GitHub Release 的附件也是它 |
| `RELEASE_NOTES.md` | 冻结的发布说明（当时那份，不会随源码变化）。GitHub Release 正文用这份 |
| `CHANGELOG.md` | 这一版的更新条目 |
| `meta.json` | 版本 / 打包时间 / git commit / 大小 / sha256 |
| `SHA256SUMS.txt` | 校验和 |
| `upload.cmd` | **双击就能上传**（Windows）。可重复运行，同名附件会先删再传 |
| `upload.ps1` | 同上，PowerShell 版 |

## 一键上传

双击 `upload.cmd`。第一次用之前要做一次性的 token 配置：

1. GitHub → Settings → Developer settings → Personal access tokens
   - classic：勾 `repo`
   - fine-grained：勾 **Contents: Read and write**
2. 在仓库根建目录 `.secrets`，里面放一个纯文本文件 `github-token`，内容是 token（这个目录在 `.gitignore` 里，不会被提交）
3. 双击 `upload.cmd`

脚本会自己：确认 commit 已在 GitHub → tag 不存在就按这个版本的 commit 创建（**不会**指向主分支最新）→ 建 Release（非 draft / 非 prerelease）→ 上传附件 → 回读确认。想先演练就运行 `node scripts/upload-release.js --version=1.1.0 --dry-run`。

## 手动上传（不想写 token）

GitHub → Releases → Draft a new release → **Choose a tag** 选已存在的 `v1.1.0`（**不要**新建 tag）→ 正文粘贴 `RELEASE_NOTES.md` → 附件选 `character-atlas-1.1.0.vnpkg` → 不要勾 prerelease、不要存 draft。
