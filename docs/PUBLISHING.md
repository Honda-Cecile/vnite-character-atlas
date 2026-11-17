# 发布指南（从本地到 Vnite「浏览」里能被搜到）

这份文档是**完整流程**，从零开始：仓库怎么建、Release 怎么发、为什么发完之后 Vnite 的插件「浏览」里会/不会出现你。

所有命令在**仓库根目录**执行（也就是 `D:\插件\character-atlas`；Windows 用 Git Bash，PowerShell 里把 `export` 换成 `$env:`）。

---

## 0. 先搞懂 Vnite 是怎么「发现」插件的

这一步比发 Release 重要。Vnite 4.x **没有人工审核的插件商店**，它的「插件 → 浏览」页其实是在**搜 GitHub 仓库**：

| 机制 | 具体规则（从 4.x 主进程 `PluginRegistryManager` 反查出来的） |
| --- | --- |
| 搜索 | `GET https://api.github.com/search/repositories?q=topic:vnite-plugin [关键词] [topic:common\|topic:scraper]&sort=stars&per_page=20` |
| 收录条件 | 仓库必须打上 **`vnite-plugin`** 这个 GitHub topic；分类由 topic `common` / `scraper` 决定（两个都有时 `scraper` 优先），都没有则取 `package.json` 的 `category` |
| 下载地址 | 取该仓库**最新 Release** 里第一个 `*.vnpkg` 资源；没有 Release 就退回 `<repo>/archive/refs/heads/main.zip` |
| 显示版本 | Release 的 `tag_name` 去掉前缀 `v` |
| 元数据 | 读**仓库根目录**的 `package.json`（`id` / `name` / `description` / `main` / `vniteVersion`）；**作者名固定取仓库 owner 的 GitHub 登录名**，`package.json.author` 不参与显示 |
| 更新检查 | 比较 `releases` 列表里（排除 draft / prerelease）的最新 tag 与本地安装版本 |

结论四句话：

1. **必须有 topic `vnite-plugin`**，否则搜不到。
2. **必须有一个非 draft、非 prerelease 的 Release，里面挂 `.vnpkg`**。
3. **`package.json` 要提交进仓库**（不能只在本地或只在包里）。
4. 仓库 owner 就是插件页显示的作者 —— 你用的是 `Honda-Cecile`，正好对上。

---

## 1. 发布前自检

```bash
npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # 应为 0 错误
npm run build                                            # → dist/index.js（单文件）
node scripts/smoke.js                                    # 真实 API 冒烟（激活 / IPC / 刮削 / 缓存 / 导出导入 / 停用）
node scripts/probe-native.js                             # 注入：标签顺序、单排、匹配、弹窗
node scripts/probe-ui.js                                 # UI：搜索、筛选、设置行、切作品清搜索
node scripts/probe-edit.js                               # 右键 → 编辑 → 删除 → 重新下发
node scripts/probe-overrides.js                          # 个人修正层（离线）
node scripts/probe-paths.js                              # 便携 / 安装两种数据目录判定（离线）
node scripts/probe-traits.js                             # 标签剧透分级 + 原名参与匹配（离线）
node scripts/probe-spoiler.js                            # 卡片/弹窗的剧透折叠开关（离线，headless Chrome）
npm run pack                                             # → dist/character-atlas-<版本号>.vnpkg
node scripts/verify-package.js                           # 包结构 / 14 项配置 / controlType / 导出符号
```

> 探针读的是 **`dist/index.js`**，改过 `src` 没 build 的话，探针测的仍是旧代码。

- [ ] 上面全部通过
- [ ] `package.json`：`id` = `character-atlas`，`name` = `Character Atlas`，`version` = 当前版本，`author` = `Honda-Cecile`，`repo` = `{owner: "Honda-Cecile", name: "vnite-character-atlas"}`
- [ ] `LICENSE`、`README.md`、`docs/` 齐全
- [ ] `docs/screenshots/` 里的 9 张图就位（`00-hero` … `08-settings`，清单与拍摄要求见 [`docs/screenshots/README.md`](screenshots/README.md)）
- [ ] `npm run release` 跑过，`releases/v<版本号>/` 里有 `.vnpkg` 与冻结的 `RELEASE_NOTES.md`
- [ ] `docs/CHANGELOG.md` 与 `docs/RELEASE_NOTES.md` 都已写上这一版的内容
- [ ] 在真实 Vnite 里装一遍：启用 → 重启 → 打开一部有角色的作品 → 人物标签页正常

---

## 2. 建 GitHub 仓库

仓库名建议 **`vnite-character-atlas`**（和 `package.json.repo.name` 一致，别用中文，别用空格）。

### 2.1 网页建空仓库

GitHub → **New repository** → 名字 `vnite-character-atlas` → **不要**勾 README / .gitignore / license（本地已有）→ Create。

### 2.2 本地推上去

```bash
cd /d/插件/character-atlas
git init -b main      # 已经 init 过就跳过
git add .
git status          # 确认列表里没有 node_modules/ dist/ *.vnpkg .tmp/
git commit -m "feat: 1.0.0 首个发布版"
git branch -M main
git remote add origin https://github.com/Honda-Cecile/vnite-character-atlas.git
git push -u origin main
```

`.gitignore` 已经排除 `node_modules/`、`dist/`、`*.vnpkg`、`.tmp/`、`*.log`。**`.vnpkg` 只走 Release，不进仓库。**

> 目录名与仓库名不必一致，插件身份由 `package.json` 的 `id`（`character-atlas`）决定；仓库名只影响 clone 地址。

### 2.3 打 topic（决定能不能被搜到）

仓库首页右侧齿轮 → **Topics**，至少填这两个：

```
vnite-plugin
common
```

（`common` 是分类，若要标成刮削器则用 `scraper`。）

### 2.4 About 栏

**Description**（GitHub 上 `package.json` 的 `description` 不参与列表显示，这里才是给人看的那句话）：

```
给 Vnite 的游戏详情页注入原生「人物」标签页：从 KunGalgame / VNDB 刮削角色头像、立绘、简介、三围、特质，卡片墙 + 详情弹窗 + 右键编辑，头像本地缓存。
```

**Topics**（除上面两个外，可再加搜索关键词 —— 它们也会进 Vnite 的 keywords）：

```
galgame visual-novel character kungal nextmoe vndb scraper electron typescript
```

---

## 3. 打 tag + 发 Release

```bash
# 假设当前版本是 1.1.0（换成你的）
git tag -a v1.1.0 -m "1.1.0"
git push origin main
git push origin v1.1.0
```

### 3.1 有 GitHub Actions（推荐）

仓库里已经带了 `.github/workflows/release.yml`：推 `v*` tag 时自动跑 typecheck → build → pack → verify → 建 Release 并挂上 `.vnpkg`，Release 正文读 `docs/RELEASE_NOTES.md`。

推完 tag 去 **Actions** 看 `release` 这次运行；成功后 **Releases** 里就有 `v<版本号>` 和附件 `character-atlas-<版本号>.vnpkg`。

如果 Actions 报 `npm ci` 失败：本地 `package-lock.json` 没提交，或 Node 版本不匹配。锁定 `node-version: 20` 已写在 workflow 里。

### 3.2 双击两个文件（零配置，最省事）

`releases/v<版本号>/` 里躺着这两个：

1. **`1-打开发布页.url`** —— 双击，用默认浏览器打开**已经预填好** `tag=v<版本号>` 和标题的新建 Release 页。
2. **`2-复制发布说明.cmd`** —— 双击，把这一版冻结的 `RELEASE_NOTES.md` 塞进剪贴板，网页正文里 `Ctrl+V`。

然后把 `character-atlas-<版本号>.vnpkg` 从资源管理器**拖进**网页的 *Attach binaries* 区域，点 **Publish release**。全程不碰命令行、不配 token、不碰 git。

两个注意：**Choose a tag 一定是已存在的那个**（别选 "Create new tag on publish"，那会打在 main 最新 commit 上）；**不要勾 pre-release / draft**，勾了 Vnite 就看不到这一版。

### 3.3 双击上传（脚本，全自动）

`releases/v<版本号>/` 里带了 `upload.cmd`（双击）和 `upload.ps1`，也可以命令行跑：

```bash
npm run upload                                        # 当前版本
node scripts/upload-release.js --version=1.1.0        # 指定版本
node scripts/upload-release.js --version=1.1.0 --dry-run   # 只检查不联网
```

一次性配置 token（只需要做一次）：

1. GitHub → Settings → Developer settings → Personal access tokens
   - **classic**：勾 `repo`
   - **fine-grained**：仓库选 `vnite-character-atlas`，权限勾 **Contents: Read and write**
2. 在仓库根建目录 `.secrets`，放一个纯文本文件 `github-token`，内容是 token（`.secrets/` 已被 `.gitignore` 排除）

更省事：**复制 token → 双击仓库根的 `set-token.cmd`**。它读剪贴板、写进 `.secrets/github-token`，并当场用 `GET /repos/{repo}` + `GET /user` 验证身份与写权限，失败会直接说清是「token 无效」还是「没有 Contents 写权限」。

脚本按顺序做：校验 `releases/v<版本号>/` 里的包（大小 + sha256 + 包内 manifest 版本）→ 确认这个版本的 commit 已在 GitHub → tag `v<版本号>` 不存在就**按该 commit** 创建（这一步专治「tag 打在 main 最新 commit 上」）→ 建 Release（非 draft / 非 prerelease，正文用冻结的 `RELEASE_NOTES.md`）→ 上传 `.vnpkg`（同名附件先删再传，可重复运行）→ 回读确认并打印下载地址。

它的好处是**完全不依赖 git push**：只要 `api.github.com` 通（很多时候 `github.com` 被墙但 API 是通的），就能发布；前提是那个 commit 已经在远端仓库里。

### 3.4 手动发（网页点，和 3.2 一样但更啰嗦）

**Releases → Draft a new release**：

- **Choose a tag**：`v<版本号>`（已推送则直接选）
- **Release title**：`<版本号> · Character Atlas`
- **Describe**：粘贴 `releases/v<版本号>/RELEASE_NOTES.md` 全文（这份已冻结，比看当前 `docs/` 更准）
- **Attach binaries**：上传 `releases/v<版本号>/character-atlas-<版本号>.vnpkg`
- **不要**勾 *Set as a pre-release*（预发布不会出现在更新检查里），**不要**存成 draft

发布后自己验证一下：

```bash
curl -s https://api.github.com/repos/Honda-Cecile/vnite-character-atlas/releases/latest \
  | grep -E '"tag_name"|browser_download_url'
```

能同时看到 `v<版本号>` 和 `.vnpkg` 的下载地址就算成了。

---

## 4. 让它在 Vnite「浏览」里出现

1. 打开 Vnite → 插件 → **浏览** 标签
2. 搜索框输入 `character` 或 `atlas`（关键词会拼进 GitHub 搜索 `topic:vnite-plugin character`）
3. 出现后点安装 —— Vnite 会直接拉那个 `.vnpkg`

**搜不到时按这个顺序排查：**

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 完全没有这个仓库 | 没打 `vnite-plugin` topic | 去仓库 Topics 补上，等几分钟让 GitHub 搜索索引更新 |
| 有仓库但版本是 `0.0.1`、装了报错 | 最新 Release 没有 `.vnpkg` 附件 | 重新上传附件，或换个新 tag 重发 |
| 列表里描述是仓库 description 而不是 `package.json.description` | 正常：列表优先用 GitHub 仓库 description | 想把 About 改好 |
| 显示的作者不是你 | 作者取仓库 owner 登录名 | 确认仓库在 `Honda-Cecile` 名下 |
| 分类是 common 但其实想做刮削器 | topic / `category` 的判定顺序 | 加 topic `scraper` |
| 装了但插件管理器提示版本要求不满足 | `vniteVersion` 范围太窄 | 当前是 `^4.0.0-beta.2`，对 4.x 都成立 |

> GitHub 搜索有缓存，改完 topic 可能要等几分钟到几十分钟。也可以在 Vnite 里关掉再打开「浏览」页强制重新请求。

---

## 5. 发布后检查

- [ ] 干净目录里再 `git clone` 一次，确认 `npm install && npm run build && npm run pack` 能跑通
- [ ] 从 Release 下载 `.vnpkg`，在 Vnite 里装一遍，插件商店里显示的版本是这次的版本号、作者是 Honda-Cecile
- [ ] 打开一部作品 → 人物标签页出现 → 刮削 → 右键编辑 → 导出 → 清空 → 导入，全链路走一遍
- [ ] 把仓库地址回填到 `package.json` 的 `homepage`（可选，插件详情页会好看些）

---

## 6. 以后怎么升版本

正常流程（每个版本都这么走，产物自动隔离归档）：

```bash
npm version patch                       # 1.1.0 → 1.1.1；加功能用 minor，不兼容才动 major
# 改写 docs/CHANGELOG.md 顶部新增的这一版条目 + 重写 docs/RELEASE_NOTES.md（这版的 Release 正文）
npm run release                         # build → pack → 归档到 releases/v<版本号>/ → 刷新索引 → 镜像备份
git add -A && git commit -m "release: v<版本号>" && git tag -a v<版本号> -m "v<版本号>"
git push origin main && git push origin v<版本号>
```

`npm run release` 之后你会拿到：

```
releases/v1.1.1/
  character-atlas-1.1.1.vnpkg     ← 上传到 GitHub Release 附件
  RELEASE_NOTES.md                ← Release 正文（已冻结，不会跟着源码变）
  CHANGELOG.md                    ← 这一版的条目
  meta.json                       ← 版本 / 打包时间 / git commit / 大小 / sha256
  SHA256SUMS.txt
releases/CHANGELOG.md             ← 累积索引（新版本在上，带下载链接）
```

- 每个版本一个目录，**互不覆盖**；同版本重跑只刷新自己那个目录。
- 整份产物同时镜像到仓库外 `../character-atlas-releases-backup/`，防止仓库目录被误删。
- `releases/**/*.vnpkg` 在 `.gitignore` 里开了例外，会随仓库一起进 GitHub —— 推上去就是异地备份。
- 想立刻发布但网络不通：产物已在 `releases/` 里放着，等网络好了再上传，不影响源码提交。
- 补归档历史版本：`node scripts/stage-release.js --version=1.0.0`（发布说明从对应 git tag 里取）。


```bash
npm version patch   # 1.0.0 → 1.0.1（修 bug）
npm version minor   # 1.0.0 → 1.1.0（加功能）
npm version major   # 1.0.0 → 2.0.0（破坏性变更）
npm run pack        # 版本号会写进 manifest.json 并生成同名 .vnpkg
git push && git push --tags
```

`npm version` 会自动 commit + 打 tag；`npm run pack` 里带了 `prepack`，会先构建再打包。

---

## 7. 仓库已经超前、要发的是旧版本怎么办

这很常见：本地已经把 1.2.0 写完并提交了，但你还想先把 1.1.0 发出去。**能发，只要三件事分清**。

### 三个东西各自独立

| 东西 | 存在哪 | 谁改它 |
| --- | --- | --- |
| `main` 分支的源码 | 仓库默认分支 | `git push origin main` |
| tag `v1.1.0` | 指向 1.1.0 **那个 commit**，与 main 的当前位置无关 | `git push origin v1.1.0` |
| Release 附件 | 你手动上传的 `.vnpkg` 文件，push 不会覆盖它 | 网页上传 |

所以「push 了 1.2.0 的 main」**不会**把 1.1.0 的附件改掉，也不会动 v1.1.0 这个 tag。GitHub 上「最新 Release 落后于 main」是常态。

### 唯一的坑：建 Release 时别用「新建 tag」

GitHub 建 Release 时默认会让你「新建 tag」，它会把 tag 打在**默认分支的最新 commit**（也就是 1.2.0）上。这样 tag 指向 1.2.0 的代码，附件却是 1.1.0 的包 —— 这才是真的串味。

正确做法：

1. 先确认 tag 已经在本地建好、且指向 1.1.0 的 commit：`git tag -l` + 看 `releases/v1.1.0/meta.json` 里的 `gitCommit`。
2. `git push origin v1.1.0`（哪怕 main 已经是 1.2.0，推这个 tag 只会推它指向的那个 commit）。
3. 网页建 Release → **Choose a tag** 里选已存在的 `v1.1.0` → 附件取 `releases/v1.1.0/character-atlas-1.1.0.vnpkg`。

### 上传前跑一次审计

```bash
npm run check:releases
```

它逐版本核对：目录名 = 包内 `manifest.version` = `meta.json` 版本 = tag 里的 `package.json` 版本 = sha256。任何一处对不上就报 ✗ 并给出原因（比如「tag v1.1.0 指向的 commit 里 package.json 是 1.2.0」）。发布前跑一遍，比自己盯文件靠谱。

### 一个可以避免全部麻烦的习惯

如果预计 1.1.0 要过几天才发，而 1.2.0 已经在写了，就**别在 main 上堆**：

```bash
git switch -c 1.2.0-dev     # 新版本放分支上，main 停在待发布的 1.1.0
```

等 1.1.0 发完，`git switch main && git merge 1.2.0-dev`，再发 1.2.0。main 始终等于「最新已发布版本」，Vnite 读到的根目录 `package.json` 也就永远和最新 Release 对得上。

（附带说明：Vnite 的插件卡片会读**默认分支根目录**的 `package.json` 来填名字/描述/`vniteVersion`，版本号则取最新 Release 的 tag。所以 1.2.0 里如果改了 `id`、`name` 或 `vniteVersion`，而 1.1.0 的包还是旧的，卡片信息就会新旧混着显示。不想混就先发 1.1.0，再推 1.2.0。）

---

## 8. 常见问题

**能让别人不装 Node 就用吗？**
`.vnpkg` 已经是打包好的单文件 `dist/index.js`，用户只需要在 Vnite 里「安装插件」选文件，不需要 Node 和 npm。

**要不要提交 `dist/`？**
不要。Vnite 的浏览列表只读仓库根的 `package.json` 和 Release 里的 `.vnpkg`；把 `dist/` 提交进仓库只会让 diff 变脏、冲突变多。

**插件的图标在哪？**
`icon.png`（仓库根，`package.json.icon` 指向它），打包时会一起进去。

**能不能同时发到别的渠道？**
可以。`.vnpkg` 就是个 zip，谁都能手动解到便携版的 `<Vnite>/app/plugins/character-atlas/`（安装版是 `%APPDATA%/vnite/app/plugins/character-atlas/`）；社区帖子里直接发 Release 链接即可。
