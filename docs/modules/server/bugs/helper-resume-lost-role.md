# 复看的子任务显示成「子任务」角色：resume 写在顶层被静默丢掉

- 状态：已修复（代码和单测随同一批改动落地，`npm run typecheck`、`npm run lint`、`npm run test:unit` 通过，`npm run test:e2e` 全部通过；端到端用例未新增，见「待确认」）
- 症状：用 `spawn_agents` 的 `resume` 接着上一次「评审」子任务复看，新卡片却是默认「子任务」角色，实际执行的提示词也换成子任务那一套
- 入口：`server/orch-mcp.ts` 的 `case 'spawn_agents'`、`shared/engine.ts` 的 `spawn`
- 根因类型：工具参数只读了嵌套层，顶层字段静默丢弃
- 模块：`server`（`server/orch-mcp.ts`），配套 `shared/engine.ts`
- 关键词：spawn_agents、resume、复看、评审、子任务、角色、agent、顶层字段、静默丢弃、agentId、HelperCards、who

## 现象

用户截图里的子任务卡片：

- 标题栏「子任务 · 复看区域硬装改动的评审修复」
- 第二行「子任务 · Pi（默认）中档 · tokenapi/deepseek/deepseek-v4-flash」
- 底部「子任务已结束，结果已交回给派它的对话。这里只能查看」

父对话按提示词的规矩用 `spawn_agents` 的 `resume` 接着上一次「评审」子任务复看，卡片显示的角色却是「子任务」（默认子任务角色在卡片上不显示名字，只剩固定的「子任务」标签）。用户原话：「评审怎么是这个子任务角色」。

本机数据实锤（数据目录 `~/.agent-panel`，任务 `e72a2133`、对话 `dadc1ef4`「家装区域Actor硬装枚举配置」）：`@chat/sub/h1` 的 `agentId` 是「评审」角色（`87e84f16`），复看产生的 `h2`、`h3` 的 `agentId` 是「子任务」角色（`3473c350`）。

## 复现条件

1. 父对话先派一个「评审」子任务（`tasks[0].agent = '评审'`），它结束。
2. 复看时把 `resume` 写在 `spawn_agents` 的**顶层**：

   ```json
   { "resume": "chat/sub/h1", "tasks": [{ "instructions": "确认这几条修复" }] }
   ```

3. `server/orch-mcp.ts` 的 `case 'spawn_agents'` 只从 `a.tasks[i]` 取 `agent` / `tier` / `resume`，顶层那份没有任何读取处，直接被丢掉。
4. `shared/engine.ts` 的 `spawn` 收到的 `spec.resume` 是空的 → `resumed` 里没有这一项 → `prev` 为空 → 当成全新子任务，角色落到 `helperRole`（`origin === 'builtin:helper'` 的必备角色「子任务」），会话也是新开的。

## 根因

1. **参数解析只读一层**：`orch-mcp.ts` 里 `list` 由 `a.tasks` map 出来，`agent` / `tier` / `resume` 都取 `x.*`。schema 里也只把这三个字段声明在 `tasks.items` 里，顶层没有；模型把它们写在顶层时既不报错也不生效。
2. **引擎的沿用逻辑本身是对的，只是没被触发**：`spawn` 里新建记录时 `agent = (prev && host.agents.find((a) => a.id === prev.agentId)) || (want && ...) || helperRole || ...`——`prev` 命中就沿用原任务的角色。问题是 `resume` 没到这一层，`prev` 根本不存在。
3. **风险同源**：同样的「只读一层」让写错名字的字段（例如 `resume_id`）也无声无息地失效，调用方以为生效了，实际派出去的是另一个角色的一份新会话，结果看起来和正常复看一样。
4. **显示层不是问题**：卡片上的角色名和实际执行的角色读的是同一处——`web/src/components/tasks/HelperCards.tsx` 的 `who()`（浮层列表）和子任务窗口 header 的 `agent` 都按 `step.agentId` 查角色，默认「子任务」角色（`origin === 'builtin:helper'`）故意不显示名字；`shared/engine.ts` 的 `runHelper` 也用 `host.agents.find((a) => a.id === step.agentId)` 决定提示词、CLI 和模型。所以「显示成子任务」和「实际就是按子任务角色跑的」是同一件事，不是渲染错位。

## 修法（下次遇到同类问题的规则）

### 工具参数的默认值要能被看见地生效，写错的字段要报错

- `spawn_agents` 顶层接受 `agent` / `tier` / `resume`，作为**整批的默认值**：单个任务里写了以任务里的为准，都没写才落到顶层，再没有就交给引擎的默认逻辑（角色沿用原任务、档位跟发起节点）。字段描述里补上「也可以写在顶层整批共用」。
- 顶层 `resume` 配多个任务直接报错：一个会话只能接着跑一轮，一批多个时说不清谁接它。
- 顶层出现不认得的字段直接报错，不再静默忽略（`SPAWN_TOP_FIELDS` 白名单），避免「写错字段名 = 换了角色和新会话」这种毫无提示的走样。

### resume 的角色：沿用原任务，不退回默认

- 命中 `resume` 时沿用原任务的角色（提示词、CLI、模型都跟着它）。
- 原角色已经被删掉、这次又没显式写 `agent` → 报错让调用方点名角色，**不退回默认「子任务」**：那等于换了个角色接着跑原来的会话，交回的结果看不出走了样。
- 显式写了同一个角色照旧通过；写了别的角色照旧拒绝（`「…」是另一个角色跑的，接着它的会话时 agent 不写或写同一个角色`）；显式写了不存在的角色报错。
- `agentId` 为空是旧数据里「没有角色」，不算「角色被删」，照旧走默认逻辑。
- 重试分支（失败、被终止、中断的子任务在原记录上重试）里，如果显式点名了别的角色就换到点名那个角色上。

### 模型的档位

`tier` 在 resume 时仍默认跟发起节点（角色决定 CLI 和模型的映射，`shared/settings.ts` 的 `agentRun`）。这是既有设计，本次没改；卡片副行的 CLI 和模型因此来自角色本身，不是从原任务抄一份。

## 防复发护栏

- `server/orch-mcp.test.ts`「spawn_agents 顶层 agent / tier / resume：整批默认值，任务里写了以任务里的为准」：顶层 `resume` 落到任务上且**不补默认角色**；顶层 `agent` / `tier` 作默认值、任务里写的优先；顶层 `resume` 配多个任务被拒；顶层写错字段（`resume_id`）被拒且不派子任务。
- `server/orch-mcp.test.ts`「resume：不写 agent 沿用原任务的角色，写了用写的，非 resume 不带 agent 才是默认子任务」：跑真引擎，断言 `@chat/sub/h3`（resume 不带 agent）、`@chat/sub/h4`（resume 带 `agent: '评审'`）都是评审角色并接着 `h1` 的会话，`h2`（非 resume 不带 agent）仍是「子任务」，且 `runAgent` 实际收到的 `agentId` 序列是 `['r', 'h', 'r', 'r']`（记录和执行一致）。
- `server/orch-mcp.test.ts`「resume：原任务的角色已经不在了就报错，不悄悄退回默认子任务」：角色被删后 resume 报错、点名让调用方写 `agent`，被拒的复看不新建子任务。
- 这三条在修复前的代码上全部失败、修复后全部通过（修之前先跑过一遍，确认能抓到这个问题）。

## 回归验证

```bash
npm run typecheck && npm run lint && npm run test:unit
wsl.exe -d Ubuntu-24.04 -- bash -lc "npm run test:e2e"
```

- `npm run typecheck` 通过（文案 4552 条 / 英文 4552 条）。
- `npm run lint` 全过（oxlint、Prettier、规则检查、凭据检查 909 个文件）。
- `npm run test:unit`：tests 1615 / pass 1614 / fail 1，唯一失败是 `server/exec/process.test.ts` 的 `taskCliAlive`（13.5s，全量并发下被拖慢的时序竞态），单独重跑该文件 3/3 通过，与本次改动无关（按教训 `lmvktszgg2sbb` 先单独重跑再下结论）。
- 写这份记录时又单独跑了一次 `npx tsx --test server/orch-mcp.test.ts`：15/15 通过，含上面三条新用例。
- `wsl.exe -d Ubuntu-24.04 -- bash -lc "npm run test:e2e"`：全部通过（退出码 0，1m 7.7s；`subagents` 分片 24 步全过）。

## 排查路径（下次定位同类问题的顺序）

1. 先在任务记录里看这条子任务的 `agentId` 和 `session`：和它要接着的那个子任务是否一致。不一致就是角色和会话都没跟过来。
2. 看 `resume` 有没有真的到引擎：`orch-mcp.ts` 的 `case 'spawn_agents'` 从哪一层读、`spawn` 里 `spec.resume` 是否为空。工具参数里「声明在 schema、代码却不读」的字段一律当「静默丢弃」查。
3. 看引擎新建记录的 `agent` 取值链（`prev` → 点名角色 → `helperRole` → 发起角色）：每一段都会在上一层为空时往后落，落错位置就是角色错乱。
4. 确认显示层是不是同源：卡片角色名、提示词、CLI 都从 `step.agentId` 出发的话，显示错就是数据错，别去改渲染。

## 落地改动

| 位置                                  | 改了什么                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `server/orch-mcp.ts`                  | `spawn_agents` 顶层接受 `agent` / `tier` / `resume` 作整批默认值（任务里写的优先）；顶层 `resume` 配多个任务报错；顶层不认得的字段报错（`SPAWN_TOP_FIELDS`）；字段描述补「可写在顶层」 |
| `shared/engine.ts`                    | resume 命中但原角色已被删、又没显式点名 → 报错不退回默认「子任务」；显式点名不存在的角色报错；`agentId` 为空的老数据不算角色被删；重试分支支持换到点名的角色 |
| `server/orch-mcp.test.ts`             | 新增 3 条用例：顶层默认值解析、resume 角色三条分支（沿用 / 点名 / 非 resume 默认）、原角色不存在时报错                      |
| `docs/modules/shared/README.md`       | 补写 resume 的角色规则和「顶层 agent/tier/resume 是整批默认值」                                                              |
| `docs/modules/server/README.md`       | 「面板能力给 Agent 用」一行补指针                                                                                            |

## 待确认

- 端到端用例没覆盖 resume 的角色：`scripts/fake-cli` 里派评审、复看都是新派（不写 `resume`），`scripts/e2e/04-subagents.mjs` 的 `resume` 相关断言是对话发消息和换目录，不是子任务角色的沿用。要补得让 fake-cli 记下 `spawn_agents` 收到的 `agent` / `resume` 并断言新子任务的 `agentId` 等于原任务的。
- 端到端测试本轮已跑：`wsl.exe -d Ubuntu-24.04 -- bash -lc "npm run test:e2e"` 全部通过（退出码 0，1m 7.7s）；上面这条覆盖面缺口仍未补。
