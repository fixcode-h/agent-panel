# OpenSpec · 阶段 4 验收、归档与项目收尾

通用规则和命令用法见同目录的 `SKILL.md`。

## 阶段 4 · 验收、归档与项目收尾

先做阶段切换检查，然后按顺序执行：

1. `openspec validate <change>`；在 `PROJECT_ROOT` 运行可执行的测试、构建、lint；对照 `PROJECT_ROOT` 与 `specs/` 逐条核对，补全 `acceptance.md`（命令、结果、逐条结论、延期验证项、成本观察）。
2. 若本次变更修复了用户报的 Bug，确认 `DOC_ROOT/modules/<模块名>/bugs.md` 和对应单 Bug 记录已更新；实现和评审中自己发现的问题不写 Bug 记录。
3. 汇总所有延期验证项，一次选择交互展示：每项的原因、影响、建议执行者、验证步骤、当前证据，选项「立即验证 / 暂缓」。AI 自己能做的项（命令、能连上的运行中程序）推荐立即验证；只能用户做的推荐暂缓。用户要求立即验证的，由后面的「执行立即验证」一步去做（工作流里有这一节点时），不在列清单这一步做（GameTest 脚本的项按 `gametest.md` 跑）；选择暂缓则在 acceptance 和交付记录标记「待用户完成」，不伪造通过。
4. **归档前门禁**：逐条核对 `tasks.md`：
   - 没有 `- [ ]`；
   - 每条 `- [x]` 要么在 `acceptance.md` 有验证证据（命令与结果），要么带 `（延期 Dn）` 且 `Dn` 在 `acceptance.md` 里有用户的决定（`accepted-risk` 或「待用户完成」，或者立即验证后已是 `passed`）；
   - 立即验证没过的项（`Dn` 写着失败）不算满足。

   `/opsx-archive` 只统计未勾选项，不会校验证据和延期项，所以这一步自己逐条核对。**门禁不过时不要问用户，也不要自己决定算了**：用 `submit_verdict` 交不通过，blockers 逐条写缺什么（哪条 task、缺什么证据、要谁做什么），面板会把这个分岔交给用户决定。门禁通过后执行 `/opsx-archive`（目录移动和主 specs 同步由该指令完成；主 specs 是否同步遵循 `project-documentation` 的交付状态规则，P4 pending 阶段同步时标注「已验收，待提交」）。
   归档操作包含归档副本内的收尾：在归档目录里更新 `tasks.md` 勾选状态、`acceptance.md` 结论等，这部分改动与目录移动、主 specs 同步一起进入同一次提交。UE 项目里这次写的 GameTest 脚本按 `gametest.md` 最后一节处理（通过的挪进 `regression/<模块>/`）。

5. **归档先于版本控制收尾**：归档完成后再按 `project-vcs` 做项目收尾，变更范围包含归档产生的目录移动和主 specs 变更。Git 项目按工作流要求的提交方式收尾，P4 项目完成 default changelist 核对与最终 pending 分桶。
6. VCS 证据以提交本身（或最终 pending 状态）和最终回复为准；不得为了回填 commit hash 再产生一次提交。

`openspec validate` 通过、测试通过或代码写完都不是完成；缺少验证证据、延期验证决策、归档或版本控制收尾时，change 保持未完成。收尾失败时保留归档目录，需要回退时用 VCS 恢复，不手工移动目录。
