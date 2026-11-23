# vcs：版本管理服务

- 状态：documented
- 职责：判断目录归哪种版本管理、跑 p4 / svn（设 PWD、限流、计数）、P4 改文件前后的签出规则；面板和插件共用
- 源码：`server/vcs/`
- 入口：`server/vcs/detect.ts`、`server/vcs/run.ts`、`server/vcs/p4-plan.ts`
- 关键词：版本管理、detectVcs、p4 edit、p4 add、签出、changelist、P4CONFIG、vcsExec、p4WritePlan
- 更新：2026-11-23

为什么这么定见 [ADR 0073](../../adr/0073-vcs-service.md)。

## 入口

| 文件                    | 做什么                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `server/vcs/detect.ts`  | `detectVcs(dir)`：往上找 `.git` / P4 配置文件 / `.svn`，同一层 git → p4 → svn，最多 12 层，不跑 `p4 where` |
| `server/vcs/run.ts`     | `vcsExec(cmd, args, cwd)`：唯一起 p4 / svn 的地方；`vcsWhy` 拼失败原因；`vcsCallCounts` 看调用次数         |
| `server/vcs/p4-plan.ts` | `p4WritePlan` 算出 edit / add / 已打开 / 落后资源；`p4Open` 执行 edit / add                                |

`server/p4-split.ts` 的 `p4Runner`、`server/exec/vcs-run.ts` 的 `vcsRun` 是 `vcsExec` 上的两种写法（返回行文本 / 失败就抛），签名为了插件兼容保留。git 只走 `server/exec/git.ts`。

## 谁在用

- 内置钩子 `p4-auto-open`（`server/hooks/p4-open.ts`）：Agent 改文件前后签出。
- UE 插件：`ue/server/vcs.ts`（所有 p4 / svn / git 调用）、`ue/server/p4-checkout.ts`（保存资源前后签出）、`ue/server/detect.ts`。
- 表格插件：`tables/server/tables/routes.ts` 的 `p4Edit`、`write.ts` 的 `ensureWritable`、`vcs-ops.ts`。

## 接新的调用方

- 判断版本管理用 `detectVcs`，不要自己往上找配置文件。
- 要改 P4 里的文件：`p4WritePlan` → 有 `stale` 先问用户（Agent 发起的改动）→ `p4Open(run, 'edit', plan.edit)` → 写 → `p4Open(run, 'add', plan.add)`。
- 插件里 import `@panel/server/vcs/...`（开放模块）；不照面板布局放文件的插件（UE）在 `panel-modules.d.ts` 里声明类型，并且在函数里动态 import，免得纯逻辑单测要拉起面板。
