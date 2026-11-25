# OpenSpec · 续接未完成的 change

通用规则和命令用法见同目录的 `SKILL.md`。

## 续接未完成的 change

续接是受控恢复，先不要写代码，先确认状态：

1. 做阶段 0 的前置检查，再用 `openspec list` / `openspec status --change <名字>` 查看现有 change 与进度；P4 项目先按 `project-vcs` 的 `p4.md` 核对 default changelist 和任务文件范围。
2. 必需产物存在且属于同一个 change：`.openspec.yaml`、`proposal.md`、`grilling.md`、`design.md`、`specs/`、`tasks.md`。`acceptance.md` 缺失但其余完整时补建骨架，不视为无效。同时确认设计共识、验收标准、实施路径和 tasks 状态已记录；不能只凭目录存在或关键词匹配恢复。
3. 产物完整有效时，先读 `handoff.md`（若有）和 `tasks.md`：
   - **有未勾选条目** → 做阶段切换检查，从阶段 3 的剩余条目继续；
   - **条目全部勾选但未归档** → 进入阶段 4。
4. 缺少必需产物、校验未通过、设计共识或验收标准不完整、状态无法确认 → 不恢复，报告并从阶段 1 重新收敛。
5. 找不到对应 change → 说明这是新需求，从阶段 0 开始。

判断依据是 change 的完整产物、OpenSpec 状态和 `tasks.md` 勾选状态，不是目录是否存在。把判断结论写进节点输出，便于工作流决定下一步。
