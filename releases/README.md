# releases —— 各版本产物（自动归档）

这个目录由 `node scripts/stage-release.js` 生成，**不要手动改里面的文件**，改源码后重新跑一遍即可。

每个版本一个目录，**互不覆盖、只增不删**：

```
releases/
  CHANGELOG.md          ← 累积更新日志（新版本在上）+ 版本索引表
  README.md             ← 本文件
  v1.0.0/
    character-atlas-1.0.0.vnpkg
    RELEASE_NOTES.md    ← 冻结的发布说明（当时 GitHub Release 的正文）
    CHANGELOG.md        ← 该版本条目
    meta.json           ← 版本 / 日期 / git commit / 大小 / sha256
    SHA256SUMS.txt
  v1.1.0/
    character-atlas-1.1.0.vnpkg
    source-v1.1.0.zip    ← 这一版的完整源码（git archive 出来的 tag 快照）
    meta.json            ← 版本 / 日期 / git commit / 大小 / 两个 sha256
    ...
```

每个版本都带一份 **源码快照** `source-v<版本>.zip`：`.vnpkg` 里只有编译后的 `dist/index.js`，
真要看/重建这一版得靠源码。快照由 `node scripts/backup-source.js` 生成（`npm run release` 时若已有 tag
会自动带一份，`publish.cmd` 推完 tag 后也会补），`npm run check:releases` 会核对它的 sha256。

## 发布某个版本

1. 进 `releases/<版本号>/`，把里面的 `.vnpkg` 上传到 GitHub Release 的附件。
2. Release 正文用同目录的 `RELEASE_NOTES.md`（已冻结，不会随源码变动）。
3. 标题写 `<版本号>`，tag 与目录名一致（例如 `v1.1.0`）。**别勾 Prerelease，别存成 Draft** —— Vnite 的浏览页只读非 draft / 非 prerelease 的最新 Release。

## 现在有哪些版本

见 [CHANGELOG.md](./CHANGELOG.md) 顶部的索引表。

## 备份

脚本会同时把同一份产物镜像到仓库外：`../character-atlas-releases-backup/`（默认路径，`--no-mirror` 可关）。

- 仓库内（`releases/`）已被 git 跟踪 → 推到 GitHub 就是异地备份。
- 仓库外镜像 → 覆盖「仓库目录被删 / 重装系统 / 换电脑」这种情况。
- 两份都是 `.vnpkg` 原文件，随时可以直接装。
