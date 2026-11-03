---
paths: server/orch-mcp.ts, shared/panel-tools.ts, server/ask-mcp.ts
---

# 面板工具按身份裁剪

## 各身份的工具清单只认快照测试，改工具时一并核对握手和名字总表

- 规则：`orchTools` 每个身份拿到哪些工具以 `server/orch-mcp.test.ts` 的 IDENTITIES 表为准，加、删、改条件时同一个提交改表和 `docs/modules/server-exec/README.md`，README 只写「工具 → 条件」不写个数；新工具名进 `shared/panel-tools.ts` 的 `PANEL_TOOL_NAMES` 并在 `web/src/lib/tasks.ts` 给显示分支；新加的身份要核对 `server/ask-mcp.ts` 握手声明的 `orchestration.enabled` 和 Pi 扩展核对的核心工具对得上。
- 起因：审计发现（df820f2 起）README 五组工具数全和代码不符；`stop_workflow`、`cherry_pick` 没登记、对话里露原始名字；186443c 加 Chat 页身份后 Pi 误报「工具清单不完整」。
- 防线：`server/orch-mcp.test.ts`「面板工具按身份裁剪」、`server/ask-mcp.test.ts` 的握手用例。

## 给某一类对话裁工具按能力和客观条件，不加「是不是某个页面」的身份开关

- 规则：一类对话少给哪些工具，在 `shared/engine.ts` 的 `makeOrchestra` 算成能力字段（`canSpawn`、`team`、`plans`）或宿主的客观条件（有没有项目、有没有并行节点），`orchTools` / `orchHint` / 握手只读这些字段；握手 `orchestration.enabled` 按清单里核心三件（`ORCH_CORE_TOOLS`）现算，不认身份。新字段别和 `Orchestra` 已有的方法同名（`spawn` 是派子任务的方法，布尔字段叫 `canSpawn`）。
- 起因：186443c6 加 `Orchestra.plain` 一刀切 Chat 页，连计划、提示词都跟着漏改（Chat 页读到 `ask_push`、「你是项目对话」），ADR 0038 改成按能力给。
- 防线：`scripts/rules-check.mjs` 第 18 条；`server/ask-mcp.test.ts` 握手用例（含和 `pi.json` 的 `CORE_TOOLS` 一致）。

## 等待类工具一次等到底，回包只交没交过的

- 规则：`wait_agents` 这类等待工具一直等到结果齐了或有人传话才返回，不按秒数切成让模型反复调用的短等待（各 CLI 的 MCP 工具超时都够长，Codex 在 `shared/clis/codex.json` 里放宽）；回包只交这次新做完的，取过的不再重交，没做完的只列 id。长等待要走 SSE 心跳，等待期间不算空闲。
- 起因：审计发现（df820f2 起）`MAX_WAIT_S=50` 加上每次重交全部结果，12 个子任务分 8 次取完回包约 21 万字。
- 防线：`server/orch-mcp.test.ts`「wait_agents：一直等到做完…」。

## 面板代做的版本管理操作，按用户实际怎么用来设计输入，被拒时提示词要堵住原生命令

- 规则：`cherry_pick` 这类替 Agent 执行的版本管理操作，输入要覆盖用户的真实来源：P4 的 changelist 可能是 pending，也可能是用户自己在 P4V 里提交的、提交在另一条 stream 上（当前工作区映射不到）。路径对不上时按 stream 层级换算（`server/cherry-pick.ts` 的 `streamMapper`）。P4 只守一条：面板只在目标建 pending、永远不 submit，Agent 也不能自己 p4 submit，除非用户明确要求；不再要求文件是「这个对话改过的」（用户 2026-11-02 定的，搬的只是这个 changelist 自己的改动，不会带上两条流本来的差异）。提示词里禁止的原生命令要按版本管理列全（git 的 cherry-pick / merge、p4 的 integrate / merge / copy / populate），否则工具一拒绝 Agent 就自己去做 stream copy。
- 起因：用户 2026-11-02 报「已经提交的 cl 还是不支持 cherrypick」——20ae2be 只认这个对话自己提交的 CL、只用 `p4 where` 找路径，用户在子流上提交的 CL 1259263 被整次拒绝，Agent 随后转去分析 stream 父子关系、准备 copy up。
- 防线：`server/cherry-pick.test.ts` 的「用户点名的已提交 changelist 在别的 stream 上」。

## 替用户执行的操作：按意图认用户的要求，冲突留给用户，不撤回

- 规则：`cherry_pick` 这类「只有用户要求才能做」的工具，按用户**最近几条**消息里的意图判断（`server/cherry-pick.ts` 的 `userAsked`，`ASK_WINDOW` 条），不能只看最后一条、也不能要求固定说法：用户说完「cherry-pick 过去」再补一句「只要 lua」时，补的那句没有关键词照样算。拒绝的说明里不要让 Agent 要用户按某句话回复。关键词避开日常用语（「提到」「拿到」不算）。
- 规则：搬的过程中有冲突不撤回：Git 停在冲突的提交上（目标分支没检出时在数据目录里开固定的工作目录，不用会被清掉的 tmp），P4 把冲突标记写进目标文件并打开在 pending 里；结果写清目录、冲突文件和怎么接着做（`git cherry-pick --continue` / `--abort`），Agent 不替用户解决冲突。只有校验不合格（不是这个对话的提交、读不出版本）才整次拒绝或跳过。
- 起因：用户 2026-11-03 报「cherry-pick 强制要求回复『cherry-pick 1267576, 只要 lua』这么一句」「有冲突也弄过去，等用户自行解决」——原来只看最后一条用户消息、有冲突整次撤回。
- 防线：`server/cherry-pick.test.ts` 的「用户最近几条消息里要求过就算」「有冲突不撤回」两组。
