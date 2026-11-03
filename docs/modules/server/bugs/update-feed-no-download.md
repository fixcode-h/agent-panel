# GitHub API 限流时检查到新版本：只能去 GitHub 下载，更新说明也是空的

- 状态：已修复（`server/update.test.ts`「Release feed 解析……」「API 被限流时退到 Release feed……」通过）
- 症状：设置 · 版本更新里点「检查更新」，提示有新版本，但右边只有「到 GitHub Releases 下载」，没有「更新到 …」按钮；最近的版本里这一条没有「下载」，展开是「没有更新说明。」
- 入口：`server/update.ts` 的 `parseFeed`、`releaseAssets`、`htmlToMarkdown`；`web/src/components/settings/UpdateSection.tsx` 的「有新版本」一行和 `ReleaseRow`
- 根因类型：兜底数据源字段不全，界面按缺字段降级成只能看
- 模块：`server`（`server/update.ts`）、`scripts`（`scripts/package.mjs` 的包名注释）
- 关键词：检查更新、有新版本、到 GitHub Releases 下载、没有下载、没有更新说明、更新说明为空、Release feed、releases.atom、限流、403、tarUrl、sumsUrl

## 现象

用户报：没开自动更新，手动点「检查更新」，有新版本时显示让去 GitHub 下载，这里不提供下载；更新说明也是空的。

## 根因

GitHub API 每小时只给 60 次未认证请求，被限流（403 / 429）、出错或连不上时，`releases()` 改读 Release 的 Atom feed 判断有没有新版本。以前 `parseFeed` 只取 tag、时间和页面链接，`tarUrl` / `zipUrl` / `sumsUrl` 留空、`notes` 为空：

- 界面看到没有 `tarUrl`，「有新版本」那一行只给「到 GitHub Releases 下载」，列表里那一条也没有「下载」「更新到此版本」；
- 展开更新说明显示「没有更新说明。」。

其实 feed 的 `<content type="html">` 里就是这个版本渲染好的更新说明；安装包和 `SHA256SUMS` 按发布的固定命名放在 `github.com/<REPO>/releases/download/<tag>/` 下面，这条路不经过 API，不受限流影响。

## 修复

- `releaseAssets(tag)` 按 `scripts/package.mjs` 的 `archives` 命名拼出四个安装包和 `SHA256SUMS` 的地址，交给已有的 `platformAsset` 选本平台的包；`parseFeed` 据此填 `tarUrl` / `zipUrl` / `sumsUrl`，大小未知记 0，下载时按响应头补。
- `htmlToMarkdown` 把 `<content>` 里的 HTML（标题、列表、段落、加粗、代码、链接）转回 Markdown 填进 `notes`。
- 安装前照常下载 `SHA256SUMS` 校验，拼错地址时下载会失败并把原因显示出来，不会装上来路不明的包。

## 回归验证

`server/update.test.ts`：feed 解析断言更新说明转成 Markdown、Linux / Windows / macOS 各自的安装包地址和校验文件地址；限流退到 feed 的用例断言列表里的 feed 版本带下载地址。
