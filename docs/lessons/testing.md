---
paths: server/**/*.test.ts, shared/**/*.test.ts, web/src/**/*.test.ts, scripts/unit-tests.mjs, scripts/lib/**
---

# 测试：增删、降级和断言

e2e 和假 CLI 在 [e2e.md](./e2e.md)，界面检查在 [ui-check.md](./ui-check.md)。

## 加测试前先查重，同一行为只断言一处

- 规则：先在同名 / 相邻测试文件和 `scripts/ui/` 里搜这条断言再写；输入矩阵已被穷举时派生值只留一条恒等断言（`childSpinning(x) === (childIcon(x) === 'running')`）。
- 起因：`task-stage.test.ts` 13 条 `childSpinning` 期望和 `task.ts` 一行派生重复（12c62bf0）。
- 防线：人工（`changed-tests.mjs --files` 列出附近已有测试）。

## 删测试只有三种理由，都不能是「跑得慢」

- 规则：纯重复、被更强断言完全覆盖、被测代码已删，满足其一才删，结论写明属于哪种和提交。
- 起因：18466ce8「测试精简 7 项」删的都是这三类（`worktree.test.ts` 转 `worktree-merge.test.ts`）。
- 防线：人工。

## 慢或偶发失败的用例降级，不删

- 规则：对时钟敏感、依赖并发窗口的单测文件加进 `scripts/unit-tests.mjs` 的 `TIMING_FILES`；只等外部事件的用例给事件循环保活（`net.test.ts` 的 `setTimeout` 补 `unref` 空转）；并行跑时分不清是哪一通调用就别取「最后一通」，按本轮提示词匹配再 `waitFor`（`03-chat.mjs`）。
- 起因：拆成计时批和并发批后 `worktree.test.ts` 201s→17s（accfdd85）；并发上限 4 下两处「取最后一通」偶发取错（f0c802d5）。
- 防线：`test:unit`、`test:e2e`。

## 这几类测试一条都不能删

- 规则：用户报过的 Bug 的回归用例（`docs/modules/*/bugs/` 每个至少一条）、数据丢失与不可逆路径（`readJson` / `writeJsonAtomic`、回收站、`task-store` 落盘窗口）、凭据与安全边界（访问令牌、越权 403）、执行器与合并流程的关键分支（`server/exec/**`、`submit_merge` 的 hold）。
- 起因：这几类失败重跑救不回来。
- 防线：人工。

## 测试数量和耗时要可见，涨了写清原因

- 规则：看两处——`test:unit` 的分批汇总（计时批 / 并发批各自条数和耗时）、`ui-timings.json`（界面检查分片耗时的快照，不提交）；涨了写一句原因。机器防护是 `rules-check.mjs` 第 14 条（分片要被 `SHARD_FILE` 收录、截图前缀认得出来，见 [ui-check.md](./ui-check.md)）和第 4b 条（文本文件不许含裸 NUL，否则 grep 跳过整份文件）——两条管的事不同，别混说。
- 起因：分片文件、`covers.mjs` 登记和文档三处曾经对不上（2d7daabe、af32cff0）。
- 防线：`npm run lint`。

## 断言要真的打到被测逻辑，且不依赖界面语言

- 规则：e2e 请求要走中间件（Host/Origin、JSON 体，否则 415）。文案断言的期望值都取 `t()`：能 `assert.equal(x, t('…', { name }))` 就别 `assert.match(x, /中文/)`；要正则就 `new RegExp(t('…'))` 并转义。或顶部 `setLang('zh')`（环境变量会被盖掉）。
- 起因：3aa0b22 被 415 拦；3ab9a8d、ded5239c 英文环境挂；`summary.test.ts` 先例又在 `cleanup.test.ts` 4 处、`schedules.test.ts` 8 处写死中文。
- 防线：改断言后 `LANG=en_US.UTF-8` 跑该文件；全量同前缀。

## 临时改坏代码验证失败后，还原别用 git checkout

- 规则：验证测试会失败时可以临时去掉修复，还原别用 `git checkout -- <文件>` / `git restore <文件>`（会丢掉未提交改动）；先 `cp` 或 `git stash push <文件>`，验证完恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时临时去掉 `process.ts` 兜底，`git checkout --` 还原抹掉了整份修复。
- 防线：人工（还原后看 `git diff --stat`）。

## 用例数只报不拦，拦的是本次净新增

- 规则：各层用例总数不设上限（ADR 0031）；`npm run lint` 只看本次净新增（新增 - 删掉，改名合并不算），大于 0 时提交说明写「测试预算:」理由。不要再加「总数超过 N 就失败」的检查：上限一顶满，之后每个提交都要补说明。重复和过时的用例用「测试验收」的「清理用例」定期一批删。
- 起因：ADR 0024 的硬上限上线两天集成层就停在 740～742，2 条合成 1 条的提交也被当成新增拦下；用户 2026-10-29 要求改成只拦新增、出包报数、批量清理。
- 防线：`scripts/lib/test-budget.test.mjs`。
