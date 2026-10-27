---
paths: scripts/e2e/**, scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, scripts/ui/**, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 加测试前先查重，同一行为只断言一处

- 规则：先在同名 / 相邻测试文件和 `scripts/ui/` 里搜这条断言再写。同一输入矩阵已被穷举时别再写派生值的期望，改成「输入 → 期望」表加一条恒等断言（`childSpinning(x) === (childIcon(x) === 'running')`）。
- 起因：`task-stage.test.ts` 13 条 `childSpinning` 期望和 `task.ts` 一行派生重复（12c62bf0）。
- 防线：人工（`changed-tests.mjs --files` 列出附近已有测试）。

## 删测试只有三种理由，都不能是「跑得慢」

- 规则：纯重复、被更强断言完全覆盖、被测代码已删或语义被替代，满足其一才删，结论写明属于哪种和提交。提速靠合并矩阵或降级。
- 起因：18466ce8「测试精简 7 项」删的都是这三类（`worktree.test.ts` 转 `worktree-merge.test.ts`）。
- 防线：人工。

## 慢或偶发失败的用例降级，不删

- 规则：对时钟敏感、依赖并发窗口的单测文件加进 `scripts/unit-tests.mjs` 的 `TIMING_FILES`；只等外部事件、没有真实 I/O 的用例给事件循环保活（`net.test.ts` 用 `setTimeout` 补上 `unref` 留下的空转）；并行跑时分不清是哪一通调用就别取「最后一通」，按本轮提示词匹配再 `waitFor`（`03-chat.mjs`）。
- 起因：拆成计时批和并发批后 `worktree.test.ts` 201s→17s（accfdd85）；并发上限 4 下两处「取最后一通」偶发取错（f0c802d5）。
- 防线：`test:unit`、`test:e2e`。

## 这几类测试一条都不能删

- 规则：用户报过的 Bug 的回归用例（`docs/modules/*/bugs/` 每个至少一条）、数据丢失与不可逆路径（`readJson` / `writeJsonAtomic`、回收站、`task-store` 落盘窗口）、凭据与安全边界（访问令牌、越权 403）、执行器与合并流程的关键分支（`server/exec/**`、`submit_merge` 的 hold）。
- 起因：这几类失败重跑救不回来。
- 防线：人工。

## 测试数量和耗时要可见，涨了写清原因

- 规则：看两处——`test:unit` 的分批汇总（计时批 / 并发批各自条数和耗时）、`ui-timings.json`（界面检查分片耗时的快照，不提交）；涨了写一句原因。机器防护是 `rules-check.mjs` 第 14 条（分片文件要被 `SHARD_FILE` 收录、截图前缀认得出来，见 [ui-check.md](./ui-check.md)）。
- 起因：分片文件、`covers.mjs` 登记和文档三处曾经对不上（2d7daabe、af32cff0）。
- 防线：`npm run lint`。

## 断言要真的打到被测逻辑，且不依赖界面语言

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体错误，不只看状态码。断言 `t()` 文案时期望值用同一个 `t()` 生成（`summary.test.ts`），或只断言状态码、错误码；确要比中文才在文件顶部 `setLang('zh')`，别靠环境变量——后加载会盖掉它。
- 起因：3aa0b22 越权测试被 415 拦下；3ab9a8d、ded5239c 两次英文环境单测失败。
- 防线：`LANG=en_US.UTF-8 npm run test:unit`。

## 假 CLI 与 e2e 分片：场景写进分片，资源和合并走 harness

- 规则：`scripts/e2e.mjs` 只是并行 runner（默认 4 片，可用环境变量调），场景放 `scripts/e2e/NN-*.mjs`、每片调一次 `runShard()`，临时目录、端口、服务、看门狗都在 `harness.mjs` 的 `setupBase()` 里，服务用 `onExit()` 登记，分片间不能有依赖。
- 规则：合并分支用 `mergeTask()`（每次尝试前清、被挡住会重试），别手工 `rmSync` 假 CLI 写的 `<kind>-output.txt`；负向用例（期望 409）拿原始错误。加触发词前先 `grep "includes('" scripts/fake-cli/fake-cli.mjs` 查被包含的旧词（`SLOW`、`FAIL`、`FAKE_*` 匹配整段输入，`IMGFAIL` 会混进来），要干净输入的自建项目。
- 起因：`BG_SLOW` 命中 `SLOW`（7a875fe）；`04-subagents` 被残留 `codex-output.txt` 挡住（409，CI 偶发）；漏关临时服务挂过 95 分钟。
- 防线：`test:e2e`（每片 10 分钟看门狗）、`outputs.test.mjs`。

## 跑 e2e / 单测前清掉继承的环境变量

- 规则：别嵌套跑 `claude`；`ANTHROPIC_BASE_URL` 用 `env -u` 去掉；`AGENT_PANEL_TRAY`、`AGENT_PANEL_SUPERVISED` 会传下去，起服务验证时置空；`rules-check.mjs` 指定仓库用 `env GIT_DIR=… node …` 前置形式，测试自建仓库的 git 子进程要清掉 `GIT_*` 一类变量；WSL 里 `node_modules` 平台不匹配时重装。
- 起因：`ANTHROPIC_BASE_URL` 混进断言；WSL 里 export 后 `git init` 写坏主仓库 `core.worktree`（`fatal: Invalid path '/mnt'`）。
- 防线：`rules-check.mjs` 第 9 条；人工。

## 临时改坏代码验证失败后，还原别用 git checkout

- 规则：验证测试会失败时可以临时去掉修复，还原别用 `git checkout -- <文件>` / `git restore <文件>`（会丢掉未提交改动）；先 `cp` 或 `git stash push <文件>`，验证完恢复，再用 `git diff --stat` 确认改动还在。
- 起因：修 Pi 面板工具时临时去掉 `process.ts` 兜底，`git checkout --` 还原抹掉了整份修复。
- 防线：人工（还原后看 `git diff --stat`）。

## 等状态用 waitFor，不用固定 sleep 或进程存活窗口

- 规则：用 `runShard` 的 `waitFor` 等状态和假 CLI 写的记录文件（状态位早于记录写入，读早了是空），一次性断言带 `label`；跨轮次等待的超时收敛成文件顶部常量（`WAIT_CLI_ROUND_MS = 60000`）。等对话空闲不能只看一阵没跑（子对话 `submit_merge` 会叫起父对话）；判节点并发用 `step.startedAt/endedAt`。否定式断言要临时去掉修复接线跑一遍。
- 起因：原脚本 54 处固定 `sleep(800)`；「切到后台不回收」第一版用 `SLOW`，旧实现没有 waiter 也通过。
- 防线：`test:e2e`；对照开关在 `docs/modules/scripts/README.md`。
