# P4 项目被认成「不是 Git 仓库或 P4 工作区」

- 状态：已修复（`server/detect-vcs.test.ts` 通过）
- 症状：项目设置的「Cherry-pick 目标」显示「项目目录不是 Git 仓库或 P4 工作区，不能设置」，而项目明明是 P4 工作区，工作区根上有 `p4config.txt`
- 入口：`server/projects-analyze.ts` 的 `detectVcs`（`/fs/vcs`、`isP4`、对话的 cherry-pick 和 P4 分 changelist 都读它）
- 根因类型：版本控制识别只认固定文件名
- 模块：`server`（`server/projects-analyze.ts`）
- 关键词：P4、Perforce、p4config.txt、P4CONFIG、p4 set、cherry-pick、不是 P4 工作区

## 根因

`detectVcs` 只认目录和上层目录里的 `.p4config`、`.p4ignore`。用户的工作区用 `p4 set P4CONFIG=p4config.txt` 把配置文件名存在 Windows 注册表里，面板进程的环境变量读不到 `P4CONFIG`，`p4config.txt` 就不算数，P4 工作区被当成没有版本控制。

## 修复

- 常见的配置文件名都认：`.p4config`、`.p4ignore`、`p4config.txt`、`.p4config.txt`、`p4config`、`P4CONFIG`，再加上环境变量 `P4CONFIG` 指定的名字。
- 都没有时问一次 p4 本身：在目录里跑 `p4 -ztag where <目录>/...`，映射出本地路径就是 P4 工作区（结果缓存一分钟，每轮对话的判断不会每次起进程）。

## 防线

- `server/detect-vcs.test.ts`：`p4config.txt` 认得出（子目录也算）、没有文件时用假 p4 的 `where` 认出、不在映射里的仍是没有版本控制。
