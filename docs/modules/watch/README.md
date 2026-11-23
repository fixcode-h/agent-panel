# watch：派生缓存和文件监听

- 状态：documented
- 职责：盯目录 / 文件 / 目录树的改动（共用系统监听）；记住算出来的东西，依赖的文件变了或过期才重算；面板和插件共用
- 源码：`server/watch/`、`server/memo/`
- 入口：`server/watch/dir.ts`、`server/watch/files.ts`、`server/watch/tree.ts`、`server/memo/index.ts`
- 关键词：fs.watch、文件监听、watchFiles、watchTree、缓存、memo、createMemo、过期、inotify
- 更新：2026-11-23

为什么这么定见 [ADR 0074](../../adr/0074-memo-and-watch.md)。

## 入口

| 文件                    | 做什么                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `server/watch/dir.ts`   | `watchDir(dir, on)`：唯一调 `fs.watch` 的地方，一个目录一个监听、订阅者共用；`openDirWatches()` 看开了几个 |
| `server/watch/files.ts` | `watchFiles(files, onChange)`：盯几个文件，停手 300 毫秒比修改时间，一次保存只回调一次                     |
| `server/watch/tree.ts`  | `watchTree(root, on)`：整棵树；Windows / macOS 递归，Linux 逐目录（最多 2000 个）                          |
| `server/memo/index.ts`  | `createMemo(...)`：在途去重、失败不记、`ttlMs`、`watch` 依赖文件；`memoStats` / `clearMemos`               |
| `server/memo/api.ts`    | `/api/memo`：设置 →「数据」的「内存缓存」一节                                                              |

## 谁在用

- 面板：文件索引（`server/file-index/watch.ts`）、「/」菜单（`server/slash.ts`）、CLI 命令查询（`server/cli/commands.ts`）、会话栏（`server/session-bar.ts`）。
- 表格插件：`tables/server/tables/watch.ts`（打开着的表格）、`enum-scan-watch.ts`（枚举扫描）。
- UE 插件：`ue/server/memo.ts`（`ueMemo` 懒加载面板模块）、GM 文件、AssetForge 配置、Lua GM 扫描的监听，UnLua 识别、离线类表和头文件、AssetForge 安装检测的缓存。

## 接新的调用方

- 要盯文件就用 `watchFiles` / `watchTree`，不直接 `fs.watch`；盯不了返回空或列在 `unwatched` 里，调用方照旧要能手动刷新。
- 要缓存就用 `createMemo`，名字写成 `<模块>.<用途>`；依赖本地文件的给 `watch`，同时给一个兜底的 `ttlMs`（网络盘、Linux 目录太多时盯不住）。
- 插件里懒加载（`await import('@panel/server/memo/index')`），只测纯逻辑的单测不用拉起面板。
