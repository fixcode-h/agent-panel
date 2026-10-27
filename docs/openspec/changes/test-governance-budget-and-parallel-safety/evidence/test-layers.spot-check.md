# 分层基线抽查记录（批 0 / tasks 1.2）

判据来自 `scripts/lib/test-layers.mjs` 的 `INTEGRATION_MARKERS`：按源码里实际出现的运行时特征判断，满足任一条即归集成层；
`scripts/e2e/` 下被总入口调度的 `NN-*.mjs` 分片只按目录归属，归 e2e 层。

- 抽查日期：2026-10-27
- 生成命令：`node scripts/test-layers.mjs --report --out docs/openspec/changes/test-governance-budget-and-parallel-safety/evidence/test-layers.json`
- 抽查方式：从报告里取 10 个文件，逐个回读源码确认判据命中处与文件实际做的事一致

| #   | 文件                                 | 判定层      | 命中特征                                  | 源码依据                                                                     | 结论 |
| --- | ------------------------------------ | ----------- | ----------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| 1   | `server/exec/hints.test.ts`          | integration | real-files                                | 第 420 行 `readFileSync(new URL('./runner.ts', import.meta.url))` 真读源码文件 | 一致 |
| 2   | `server/p4-split.test.ts`            | pure        | —                                         | 只有 `re.exec(...)` 解析文本，不起服务、不开子进程                            | 一致 |
| 3   | `server/exec/worktree.test.ts`       | integration | temp-dir、real-files                      | `mkdtempSync` 建多个临时仓库目录，`readFileSync` 校验落盘内容（13 例）        | 一致 |
| 4   | `server/exec/worktree-merge.test.ts` | integration | real-files、git、child-process            | `execFileSync('git', ['init' …])` 在临时仓库上跑 git 合并（29 例）            | 一致 |
| 5   | `server/task-store.test.ts`          | integration | temp-dir、real-files                      | `mkdtempSync` 建数据目录后读写 JSON 落盘                                     | 一致 |
| 6   | `shared/alerts.test.ts`              | pure        | —                                         | 只 import 被测模块和断言库，91 行 7 例                                       | 一致 |
| 7   | `web/src/lib/title-count.test.ts`    | pure        | —                                         | 前端纯逻辑，只做字符串与计数计算                                             | 一致 |
| 8   | `scripts/e2e/read-log.test.mjs`      | integration | temp-dir、real-files                      | e2e 日志读取脚本自身的单测，`mkdtempSync` + `writeFileSync` 造日志文件        | 一致 |
| 9   | `scripts/lib/changed-tests.test.mjs` | pure        | —                                         | 只测定位规则，输入输出都是内存里的对象                                       | 一致 |
| 10  | `scripts/e2e/03-chat.mjs`            | e2e         | —（分片只按目录归属）                     | 被 `scripts/e2e.mjs` 收集的分片，18 个 `step(…)` 步骤                        | 一致 |
| 11  | `server/exec/system-prompt.test.ts`  | integration | real-files                                | `node:fs/promises` 的 `readFile` / `rm` 真读写临时目录（首版判据漏了异步版，评审 R1 指出后补入） | 一致 |

## 结论

- 10 个抽查文件（加评审补抽的 `server/exec/system-prompt.test.ts` 共 11 个）的分层与源码实际做的事一致，判据可以直接用于预算基线。
- 判据是静态文本匹配，已知两处偏差，都不影响分层结论：
  - 测试样例里若出现 `spawn(`、`mkdtempSync(` 一类**调用写法**的字样，文件会被判成集成层；样例源码因此单独放在 `scripts/lib/test-layers.samples.mjs`。
  - 单个字符串 `'git'`（例如断言里列特征标签）不算执行 git，判据要求「子进程 API 直接跑 git」才算。
- 静态用例数与 tap 实测一致（2026-10-27 全量：静态 2222、tap 2222，差 0）；预算按静态口径取整，CI 再跑完单测后用 tap 复核一次，防写法分叉。
- 首版判据只收了 `*Sync` 的文件 API，`node:fs/promises` 的 `readFile` / `rm` 漏判，`server/exec/system-prompt.test.ts`（5 例）被算进纯函数层；补齐后重跑基线：纯函数层 172 个文件 / 1500 例、集成层 80 个文件 / 722 例（详见评审 R1）。
