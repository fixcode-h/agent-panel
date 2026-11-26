# OpenSpec · 规范场景转成 GameTest 测试（UE 项目）

通用规则见同目录的 `SKILL.md`。只在 UE 项目、装了 GameTest（有 `ue_gametest` 工具、`ue_gametest action=look what=status` 能看到场景根）时用；其他项目跳过本文件。

为什么：离线单测的桩是按你的理解写的，接口用错了桩照样通过（复盘 2026-11-26：`.Rotator` 应为 `.Rotation:ToRotator()`，桩里照写，直到收尾的游戏内测试才抓到）。规范里能在游戏里看到效果的 Scenario，要有一份真在游戏里跑的 GameTest 脚本；离线桩只能补充，不能代替它算「通过」。

## 阶段 2：在验收骨架里标出来

建 `acceptance.md` 骨架时，每条 spec 的 Scenario 判断一次「能不能在游戏里操作到、看到」：能的，验证方式写 `GameTest：openspec/<change>/<Rn>-<场景短名>.json`（场景根下的相对路径，阶段 3 写）；纯数据、纯工具链的照旧写命令或检查步骤。

## 阶段 3：写脚本草稿并校验

做完一组 tasks（代码已经在、对象和接口名能查到）后，按 `ue-gametest-authoring` 技能给这组覆盖的每个标了 GameTest 的 Scenario 写一份 v5 脚本：

- **位置和标记**：场景根下 `openspec/<change>/<Rn>-<场景短名>.json`；`name` 写 Scenario 标题；`tags` 写 `openspec`、`<change>`、`agent`；第一步的 `note` 写对应的需求和 Scenario 名，报告里能对回规范。
- **对照写法**：GIVEN（前提）→ 准备状态（`api` / `obj.call` 调项目接口、GM，`set` 记初值）；WHEN（操作）→ 界面操作或调函数；THEN（结果）→ 对象判断或表达式检查，一个 THEN 至少一条判断。规范里没写清、脚本里只能猜的值（地图、数量、按钮名）先用 `look` 查，查不到的写进 `params` 并在 `note` 里写明是猜的。
- **校验**：`ue_gametest action=validate scenario=<路径>` 必须过；返回 `offline: true` 只查了结构，开着编辑器时再校验一次。
- **跑**：在项目目录里直接改、编辑器连得上、改动不用编译就生效时，加载冒烟起了 PIE 之后直接 `ue_gametest action=run scenario=<路径>`，`job` 等完、`report` 取结果，把结果（通过 / 失败的步骤和原因、报告路径）写进 `acceptance.md` 对应行。跑不了的（独立分支、要编译 C++、编辑器没开）登记延期项 Dn，验证步骤写 `ue_gametest action=run scenario=<路径>`，tasks 勾成「（延期 Dn）」。
- 失败时先分清是功能 bug 还是脚本写错（`ue-gametest-authoring`「失败了怎么判断」）：功能 bug 按 `stage-3.md` 修；脚本错改脚本。不要为了通过删判断、放宽条件。

## 阶段 4：延期验证和归档

- 列延期验证项时，GameTest 的项在验证步骤里写脚本路径，推荐「立即验证」（编辑器连得上时 Agent 自己能跑）。
- 执行立即验证：逐个 `ue_gametest action=run scenario=<路径>`，通过记 `passed` + 报告路径；失败记失败的步骤、原因和报告路径，不改代码修。
- 归档时：通过的脚本挪进场景根的 `regression/<模块>/`，`tags` 加 `regression`，以后能 `run tag=regression` 回归；没过或没跑的留在 `openspec/<change>/`，在 `acceptance.md` 写明状态。
