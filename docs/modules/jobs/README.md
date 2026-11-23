# jobs：后台作业

- 状态：documented
- 职责：登记面板和插件里能跑一阵子的事（编译、安装、下载、扫描），推送状态，侧栏底部一处看全、看日志、取消
- 源码：`server/jobs/`、`shared/jobs/`
- 入口：`server/jobs/registry.ts`、`server/jobs/api.ts`、`web/src/lib/live/bg-jobs.ts`、`web/src/components/layout/sidebar/BgJobsSidebarStatus.tsx`
- 关键词：后台任务、作业、进度、取消、startJob、bg-jobs、侧栏底部
- 更新：2026-11-23

为什么这么定见 [ADR 0075](../../adr/0075-background-jobs.md)。

## 怎么用

- 服务端（面板或插件经开放模块）：`const job = startJob({ source: 'ue', projectId, kind: 'build', title, cancel })`，跑的时候 `job.log(...)`、`job.progress({ phase, done, total })`，结束 `job.end(ok, info)`。取消时面板调 `cancel`，调用方照常 `end`，状态会记成已取消。
- 网页：`useBgJobs()` 拿整份（已排序：跑着的在前）；侧栏底部的 `BgJobsSidebarStatus` 和「后台任务」弹窗已经接好，别的页面要显示同一份就用这个 hook，不另取。
- 演示版：`web/src/lib/demo/demo-bg-jobs.ts`。

## 谁在用

- UE 插件：编译、安装（`ue/server/jobs.ts` 镜像过来）。
