---
paths: shared/hooks.ts, shared/hook-defs.ts, shared/hook-mod.ts, server/hooks/**, shared/clis/pi.json, shared/clis/codex.json, shared/clis/claude.json, shared/clis/commandcode.json
---

# 钩子（ADR 0049）

## 写进 CLI 扩展、mod 的钩子代码，要真的被那个 CLI 加载跑一遍

- 规则：假 CLI（`scripts/fake-cli`）不加载 Pi 的桥接扩展、Command Code 的 mod，e2e 全绿也证明不了扩展里的钩子会触发。改这些源码后：能装 CLI 的用真 CLI 跑一次（日志里要看到「结束前钩子」那几行）；装不了的把生成的源码加载起来、接本地假面板逐个调用（`shared/hook-mod.test.ts` 的做法）。读 CLI 源码定下的判断条件，要对照它真实调用时的值。
- 起因：ff99f64a 的 Pi 扩展在 `agent_before_settle` 里按 `context.canContinue === false` 提前返回，可那一刻最后一条总是模型回复，这个值永远是 false，第三期真实接口测试才发现一次都没问过面板。
- 防线：`shared/hook-mod.test.ts`（Command Code 的 mod）；Pi 人工（真实运行）。

## 按命令匹配要按段比，别只比整条命令的开头

- 规则：模型常写 `cd 项目 && npm test`、`npm test 2>&1 | tail`。用户钩子的命令前缀、只读守卫的写命令都按 `commandSegments`（按 `&&`、`||`、`;`、`|`、换行拆开）逐段比。
- 起因：第三期真实测试里 Pi 跑 `cd … && npm test`，「不许跑 npm test」的钩子按整条开头比没拦住。
- 防线：`shared/hook-defs.test.ts`「范围和匹配」。
