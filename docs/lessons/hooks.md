---
paths: shared/hooks/index.ts, shared/hooks/defs.ts, shared/hooks/mod.ts, server/hooks/**, shared/clis/pi.json, shared/clis/codex.json, shared/clis/claude.json, shared/clis/commandcode.json
---

# 钩子（ADR 0049）

## 写进 CLI 扩展、mod 的钩子代码，要真的被那个 CLI 加载跑一遍

- 规则：假 CLI（`scripts/fake-cli`）不加载 Pi 的桥接扩展、Command Code 的 mod，e2e 全绿也证明不了扩展里的钩子会触发。改这些源码后：能装 CLI 的用真 CLI 跑一次（日志里要看到「结束前钩子」那几行）；装不了的把生成的源码加载起来、接本地假面板逐个调用（`shared/hooks/mod.test.ts` 的做法）。读 CLI 源码定下的判断条件，要对照它真实调用时的值。
- 起因：ff99f64a 的 Pi 扩展在 `agent_before_settle` 里按 `context.canContinue === false` 提前返回，可那一刻最后一条总是模型回复，这个值永远是 false，第三期真实接口测试才发现一次都没问过面板。
- 防线：`shared/hooks/mod.test.ts`（Command Code 的 mod）；Pi 人工（真实运行）。

## 钩子换成 HTTP 类型前，逐个事件用真 CLI 确认它会跑

- 规则：CLI 支持 `type: http` 的钩子不等于每个事件都支持。换写法前用真 CLI 逐个事件看面板收没收到请求（压缩类事件要真把上下文压满），不跑的事件写进 CLI 定义 `hooks.http.commandOnly`，照旧走 curl / 转发脚本。
- 起因：Claude Code 2.1.318 起所有钩子换成 http，2.1.325 实测 SessionStart 的 http 钩子不论 startup / resume / compact 都不跑，「压缩后补回计划」在 Claude Code 上从没生效（2026-11-15 长对话实测，任务日志里一次「压缩后补回计划」都没有）。
- 防线：`shared/hooks/index.test.ts`「CLI 只认命令类钩子的事件」。

## 按命令匹配要按段比，别只比整条命令的开头

- 规则：模型常写 `cd 项目 && npm test`、`npm test 2>&1 | tail`。用户钩子的命令前缀、只读守卫的写命令都按 `commandSegments`（按 `&&`、`||`、`;`、`|`、换行拆开）逐段比。
- 起因：第三期真实测试里 Pi 跑 `cd … && npm test`，「不许跑 npm test」的钩子按整条开头比没拦住。
- 防线：`shared/hooks/defs.test.ts`「范围和匹配」。

## 用户说「不许跑」的命令要在守卫里拦，不只写提示词；守卫排在长命令守卫后面

- 规则：用户明确不许 Agent 自己跑的命令（例如 UE 的 Automation RunTests），提示词里写了也要加工具前守卫拦下（拦截原因里写改用什么），用户亲口要求时走 `request_override` 放行。新守卫若拦的是长命令，放在 `long-command-guard` 后面：前台跑先被转后台，到 `run_background` 再拦，放行卡只弹一次；排在前面时放行用在前台那次，转后台又要再点一次。
- 起因：用户 2026-11-23 报 UE 项目里 Agent 老自己跑 `UnrealEditor-Cmd -ExecCmds="Automation RunTests …"`，测不出东西还费时间；默认测试步骤、项目分析的「测试：Automation RunTests」和 ue-project-structure 技能都在引它去跑。实跑时守卫排在长命令守卫前，用户要求跑也得点两次放行卡。
- 防线：`server/hooks/guards.test.ts`「UE 自动化测试守卫」。

## 能由面板执行的版本管理动作不要只写进提示词，也不要按只读属性猜

- 规则：P4 改前签出、新文件 add 这类「每次改文件都必须做」的事由面板钩子做（`server/hooks/p4-open.ts`），提示词里的说法只作补充；要不要签出看 `p4 fstat` 的结果（在库里没打开才 edit、已在 pending 里不动、库里没有写完再 add），不按文件只不只读猜：client 设了 allwrite 或文件被去掉过只读时，按只读判断会整批漏掉。
- 起因：用户 2026-11-23 报 P4 项目里 Agent 改的代码和 UE 资源不进默认 Changelist。
- 防线：`server/hooks/p4-open.test.ts`；插件仓库 `ue/server/p4-checkout.test.ts`。
