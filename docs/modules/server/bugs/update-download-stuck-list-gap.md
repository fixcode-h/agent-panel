# 版本更新一直「下载中 0.0 MB」不动，最近的版本列表缺了中间几版

- 状态：已修复（`server/update/fetch-package.test.ts`、`server/update/index.test.ts` 通过）
- 症状：设置「版本更新」点更新后一直「下载中 0.0 MB / 35.9 MB」；列表里最新版下面直接跳到很早的版本
- 入口：`server/update/index.ts` 的 `install`、`releases`；`server/update/fetch-package.ts`；`server/github-sources/index.ts`
- 根因类型：下载只在请求出错时换路，连上不给数据时干等；兜底数据源只取了第一条
- 模块：`server`（`server/update/`、`server/download.ts`、`server/github-sources/`）
- 关键词：版本更新、下载卡住、0.0 MB、换来源、GitHub API、Release feed、版本列表缺失、限流

## 现象

用户报：当前 v0.29.114，更新到 v0.29.115 一直「下载中 0.0 MB / 35.9 MB」；「最近的版本」v0.29.115 下面直接是 v0.29.109，110~114 不见了。

## 根因

1. 安装包下载只有 netFetch 的多来源兜底：只在请求报错、5xx、限流时换来源。连上 release-assets.githubusercontent.com 却拿不到数据时，每片要等空闲超时、重试 4 次，好几分钟都停在 0，页面也看不出在用哪个来源。
2. 版本列表在 GitHub API 不可用（限流或连不上）时退到 Release feed，但只取了 feed 的第一个版本并进上次的缓存，缓存之后、最新版之前的几版都没有。多来源兜底让仓库文件取不到时也去 API 取，更容易把不登录每小时 60 次的配额用完，于是更常退到 feed。
3. `downloadFile` 从 `.part.json` 续传时没把已下好的部分报给 onBytes，进度条到不了 100%。

## 修复

- 新增 `server/update/fetch-package.ts`：GitHub API 附件地址（先取 302 跳转地址，只耗一次配额）→ 原地址 → 设置里打开的镜像前缀，逐个试；60 秒没收到数据就换下一个，`job.source` / `job.attempts` 显示在设置页。换来源时已下好的分片按 `resumeKey` 接着用。
- Release feed 解析全部条目（`parseFeedAll`），全部并进列表；API 列表记下附件的 API 地址。
- `github-sources`：API 来源 403/429 后按恢复时间冷却，期间跳过。
- `downloadFile` 续传时先报已有的字节数。
