# OpenSpec · 阶段 2 落规范

通用规则和命令用法见同目录的 `SKILL.md`。

## 阶段 2 · 落规范

1. `/opsx-propose` 将 proposal.md、specs/、design.md、tasks.md 写入 `DOC_ROOT/openspec/changes/<change>/`。普通项目 `DOC_ROOT` 是 `PROJECT_ROOT/docs`；P4 / SVN 项目按「文档」角色的文档位置，默认是和项目文件夹同级的 `docs`（在项目外，不做 P4 / SVN 操作）。`grilling.md` 作为 design.md 的决策依据保留。
2. proposal 必须写明**非目标**和**可核对的验收标准**；specs 的每条需求都要能被验收步骤逐条对上。
3. `tasks.md` 的形状：按可验收能力分组，保持 3–7 组；每条 task 写明验证方式（命令或检查步骤）和对应的 spec 需求。勾选的含义是「验证已通过」，不是「代码已写完」。
4. 建立 `acceptance.md` 骨架：逐条列出 spec 需求、对应验证方式、状态（待验证），并留出「本轮成本观察」三项（非必要用户打断次数、重复探索、验证失败及修复）。阶段 3、4 往里填证据。
5. 确定受影响模块后，读取 `DOC_ROOT/modules/<模块名>/README.md` 和 `bugs.md`。`bugs.md` 命中相同症状、入口、错误信息或根因类型时，在 `design.md` 记录引用和本次如何避免复发；没有命中则明确记录「未命中历史 Bug」。

**阶段 2 出口门禁**：`openspec validate <change>` 没有 ERROR（WARNING 不算，见 `SKILL.md`）；每条 spec 需求至少被一条 task 的验证覆盖，没有遗漏；`design.md` 不含「待定」项（有则回到对应决策分支重新压测，不得带着待定进入实现）。
