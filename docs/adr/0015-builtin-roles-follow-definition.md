# ADR 0015：内置角色只认内置定义，每次更新都覆盖成新版

状态：已接受 · 2026-10-25

## 背景

用户 2026-10-25 发现「调研」「通用约束」「方案设计」「开发」四个内置角色在本机永远停在 10-21 的旧版，新加的「搜索范围」「回合怎么推进」等规则一直没拿到，子任务因此空转。用户的要求：内置角色、工作流只存一份，用到就去那里取；新版本有变更就用新版覆盖；之前的对话再聊也要用新角色。用户改过的内置角色怎么办，用户选了「一律强制覆盖成新版」。

## 事实核对（改动前）

| 位置                                               | 现状                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/store.ts`                                  | 角色、工作流都只存在数据目录（默认 `~/.agent-panel/config/agents.json`、`workflows.json`），全机一份，不跟项目、不跟安装目录                                                                   |
| `server/tasks.ts`                                  | 每一轮开跑前 `deps.agents.list()` 重新读角色，对话里不存角色快照                                                                                                                               |
| `shared/builtin/core.ts` `syncCore`                | 8 个必备角色每次启动、每次保存都按内置定义改写，不会卡                                                                                                                                         |
| `shared/builtin/install.ts` `upgradeBuiltinAgents` | 其他内置角色只有 name / description / instructions 和 `legacy.ts` 里登记的某个历史版本**逐字相同**才升级；漏登记一版，这一版的副本永远升不上来（10-21 那版就是 `SCENE_TEXT` 内联展开后没登记） |
| `upgradeBuiltinWorkflows`                          | 内置工作流同样靠 `LEGACY_WORKFLOWS` 逐个比对历史版本                                                                                                                                           |
| `server/exec/runner.ts`                            | Claude Code、Codex、Pi 每一轮都通过系统提示词带角色；Gemini、Command Code 没有系统提示词参数，角色只在会话第一轮的提示里带一次，续接的旧会话一直是旧角色                                       |

## 决策

1. **内置角色（不只是必备角色）由面板维护**：`builtinKey`（来源 `builtin:<key>` 且还有内置定义）的角色，名称、简介、图标、角色设定、Skill、能力、参数定义、引入关系每次启动、每次保存都换成当前定义（`syncCore`）。用户能改的只有参数取值、运行配置、分类、标签、启用开关；想改设定就复制一份（复制出来的来源为空，是普通角色）。不再判断「改没改过」，也就不存在「漏登记历史版本就卡住」。
2. **覆盖前备份**：被覆盖的副本不是任何已知版本（说明用户改过）时，启动时写进 `config/backup/removed-agents-*.json`，日志里点名。
3. **旧对话用新角色**：Gemini、Command Code 续接旧会话时，角色设定和这个会话上次带的不一样（`Task.roleHashes` 记指纹），在这一轮开头补发「你的角色（已更新…）」。以前开的会话没记过指纹，按变了补一次。
4. **内置工作流按副本自己的指纹判断**：面板每次写内置工作流副本时记下内容指纹（`Workflow.builtinHash`，坐标不算）。启动时内容还是这个指纹就是没改过，直接升级到新定义，不管停在哪个历史版本；没记过指纹的老副本再按 `LEGACY_WORKFLOWS` 比，和当前定义一致的补记指纹。用户改过的工作流不动——工作流的选择题只问了角色，工作流里用户常改节点和参数，整体覆盖代价大，留作开放问题。

没选的方案：

- **继续补指纹**（dev 75b1da7 做过一次）：只能修已经发现的那一版，下次漏登记还会卡。
- **副本记指纹、改过的保留并提示有新版**：用户选了强制覆盖。
- **内置角色不落副本，运行时直接读定义**：运行配置、参数取值、分类、标签还得存在某处，引用关系（工作流节点、项目默认角色都按 id 引用）也要改，动得太大；落副本 + 每次同步效果一样。

## 与现有实现的关系

- `shared/builtin/core.ts`：新增 `builtinKey` / `isBuiltinAgent` / `builtinDefinition`；`syncCore` 对非必备角色保留启用开关。
- `shared/builtin/install.ts`：`upgradeBuiltinAgents` 改成无条件同步，覆盖用户改过的副本时回调 `onReplaced`；`seedProjectWorkflows` 返回 `replaced`；新增 `workflowFingerprint`，`addBuiltinWorkflow` 建副本时记指纹。
- `server/index.ts`：`PUT /agents/:id` 对所有内置角色走 `syncCore`；`POST /agents` 本机已有同来源时去掉来源（复制出来的是普通角色）；启动时备份被覆盖的副本。
- `web/src/components/agents/AgentDetail.tsx`：内置角色的设定、Skill、参数定义只读，标「内置」，不显示「AI 优化」。演示版 `demo-backend.ts` 同步。
- `shared/builtin/legacy.ts` 的角色指纹仍用于：判断要不要备份、已合并角色的 `pruneMergedAgents`。改内置角色定义**不用再登记旧指纹**。

## 运行时

启动 → `seedProjectWorkflows` → `upgradeBuiltinAgents` 同步全部内置角色（没有变化不写盘）→ 备份被覆盖的用户版本 → `ensureProjectAgents` 再给必备角色定分类、做一次性默认值升级。对话下一轮读到的就是新角色；Gemini、Command Code 续接时补发。

## 分期

一次做完。

## 风险与代价

- 用户手改过的内置角色设定会被覆盖：有备份文件，界面也明确写了「想改设定就复制一份」。
- 参数 key 改名时用户填的取值会丢（`keepParamValues` 按 key 和类型对），和必备角色一样，改定义时别乱改 key。

## 开放问题

- 内置工作流要不要也强制覆盖：倾向先观察指纹方案够不够；用户要求时把 `upgradeBuiltinWorkflows` 的「没改过才升级」去掉并加备份即可。
