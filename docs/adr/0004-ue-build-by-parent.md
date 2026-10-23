# ADR 0004：UE 编译归父对话，按编译目录占位

状态：已接受 · 2026-10-23

## 背景

093a41e 定的分工是「父对话只统筹，子对话在自己的独立分支里编译测试，跑通再合回」。对普通项目这没问题，对 UE 项目不行：
UBT / UHT、Editor、DDC、Shader 编译是整台机器共用的，几个子对话各自在 worktree 里编译，只会互相抢 `-WaitMutex`、重复生成 `Intermediate`，把机器撑满。
之前靠 `ue-multi-agent-coordination` 技能让 Agent 自己按「资源锁」排队，可锁全靠 Agent 自觉写文件，面板管不住。

用户 2026-10-23 的要求：

- 删掉 `ue-multi-agent-coordination` 和 `lua-luac-compiler` 两个技能；
- UE 的编译都走父对话，子对话不编译；父对话之间也能通讯；
- 父对话也是申请模式，不随意编译：编译是资源，走占位；按项目实际来，各自 worktree 的就互不占位。

## 事实核对

| 位置                                                     | 现状                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `server/background.ts` `start`（`exclusive`）            | 独占命令按 `root` 目录排成一条链，同一目录同一时间只跑一条                                   |
| `server/background.ts` `occupants`                       | 新增：列出某个目录里还没结束的独占命令（正在跑的在前），用来回答「谁占着编译」               |
| `server/exec/worktree.ts` `isBigProject`                 | 项目目录或仓库根有 `.uproject` 就算 UE 项目（原来只用于跳过 LFS 检出），现在也导出给编译判断 |
| `shared/test-steps.ts` `buildSteps` / `isUeBuildCommand` | 申请编译跑哪些步骤；认出 Build.bat / UBT / UHT / RunUAT / Editor 这类命令                    |
| `server/tasks.ts` `childRequestBuild` / `askParentBuild` | 子对话的申请交给父对话并叫醒它                                                               |
| `server/tasks.ts` `parentRequestBuild`                   | 父对话申请：把编译步骤排进后台独占队列，告诉申请方谁占着、告诉占着的父对话有人在等           |
| `server/tasks.ts` `peerList` / `messagePeer`（host）     | 同一项目的其他顶层父对话；传话时对方在跑就实时送达，空闲就开一轮                             |

## 决策

**UE 项目（有 `.uproject`）里，编译只能由父对话按申请发起，面板按编译目录占位排队。**

- 子对话不编译：提示里写明，`run_background` 交来的 UE 编译命令直接拒绝。
  - 有独立分支的：改动要先进父对话的目录才编得到，所以 `submit_merge` 多一个 `build`（默认 true），合回去后面板替它向父对话申请。
  - 共用目录的：用 `request_build` 申请。
- 父对话不随手编译：只在收到申请或用户要求时调用 `request_build`。面板跑项目测试步骤里标「合并时编译」的步骤（没有就认名字带「编译」的），
  交给后台独占队列，键是父对话的目录。同一目录里别的父对话占着时排在后面，双方都会被告知；父对话在各自 worktree 里时目录不同，互不占位。
  `run_background` 直接跑 Build.bat 也会被拒绝，不能绕过排队。
- 父对话之间用 `list_peers` / `message_peer` 协调（不限于 UE 项目）。

没选的做法：

- **保留技能里的资源锁**：锁文件靠 Agent 自觉写、自觉释放，崩了就留下死锁；面板本来就有按目录排队的独占队列，用它更可靠。
- **子对话申请后由面板直接编译、不经过父对话**：用户要求父对话也走申请，多个子对话的申请由父对话合成一次编译，省掉重复的全量编译。
- **另做一套编译锁服务**：后台独占队列已经是按目录的互斥，再造一套只会和它打架。

## 与现有实现的关系

- 普通项目不变：子对话照旧在独立分支里编译测试，见 ADR 0002 / 0003。
- 合并（`submitMerge` → `integrate`）的门禁不变；UE 子对话的 `tests` 写它做过的不用编译的检查。
- 下线的两个技能登记在 `server/bundled-skills.ts` 的 `RETIRED_BUNDLED`（按部署目录的「分类/名字」），部署时清掉和当初一样的旧副本；
  已装角色副本里留着的名字由 `shared/skill-guide.ts` 的 `RETIRED_SKILLS` 在拼提示词时跳过。
