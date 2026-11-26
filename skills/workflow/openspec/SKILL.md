---
name: openspec
description: OpenSpec 规范驱动开发的规则：前置检查（CLI 必须在 DOC_ROOT 下运行、.openspec.yaml 判定）、各阶段产物（grilling.md、proposal/specs/design/tasks、acceptance.md）与出口门禁、设计假设被证伪时的回流、延期验证与归档前证据门禁、CLI / 斜杠指令 / 直接改文件的分工和 ADR 门槛。执行 OpenSpec 流程的任一阶段、续接未归档的 change 或验收归档时使用。
user-invocable: true
---

# OpenSpec 开发流程

阶段顺序（0 前置检查 → 1 需求收敛 → 2 落规范 → 3 实现 → 4 验收归档）由 Agent 面板的工作流驱动：工作流的节点决定当前处于哪个阶段、何时请用户确认、何时回到上一步。本技能只规定每个阶段要做什么、产出什么、满足什么门禁才算完成。执行当前节点对应的阶段，不越过它去做后续阶段的事。

## 先读哪份

本文件是所有阶段都用的规则；每个阶段的做法在同目录的分文件里，**只读当前阶段那一份**，不用把其他阶段的读一遍（实跑里整份技能在 8 个节点里被重复读了 8 次）：

| 当前在做                                        | 读                 |
| ----------------------------------------------- | ------------------ |
| 前置检查、需求收敛和压测                        | `stage-0-1.md`     |
| 写 proposal / specs / design / tasks、规范门禁  | `stage-2.md`       |
| 按 tasks 实现                                   | `stage-3.md`       |
| 延期验证、验收、归档、项目收尾                  | `stage-4.md`       |
| UE 项目：规范场景写成 GameTest 脚本、在游戏里跑 | 加读 `gametest.md` |
| 续接没做完的 change                             | `resume.md`        |

## 通用规则

- 每个阶段都要有可核对的证据；门禁不满足时报告缺什么，不得绕过门禁继续写代码；用户明确要求跳过某个门禁时照做（用户的指令优先），在任务记录里写明跳过了什么、谁要求的。
- AI 无法执行或客观确认的非阻塞验证，登记为「延期验证」（编号 D1、D2…）：原因、影响、建议执行者、验证步骤、当前证据、状态（`deferred` / `accepted-risk` / `passed`），写入 `acceptance.md`；不得伪造通过，也不因此中断其余安全步骤。**会让别人的环境直接坏掉的问题不是延期验证**（例如引用了还没生成的枚举、表、蓝图，没生成的人一同步就报错），按阻断处理，见 `stage-3.md`「运行期依赖」。
- **阶段切换检查**：进入阶段 2、3、4 以及续接恢复时，先重新确认当前 change、`PROJECT_ROOT`、`DOC_ROOT`、`tasks.md` 状态。不得把前一阶段未完成的决策或未验证的产物当作已完成事实。
- **tasks 的勾选**：`- [x]` 表示这条的验证通过、`acceptance.md` 有证据。实现完了、但验证登记成延期的，写成 `- [x] <原文>（延期 D2）`，`D2` 是 `acceptance.md` 里的延期验证编号；其余情况保持 `- [ ]`。归档门禁按这个规则核对（`stage-4.md`）。

## OpenSpec 命令怎么用

状态由 OpenSpec CLI 管理，内容由文件记录。所有命令都在 `DOC_ROOT` 下运行（从别处运行会输出空列表或报错，容易误判成「没有 change」）。

- **常用命令的写法**（照抄，别猜参数）：
  - `openspec list`：列出没归档的 change。
  - `openspec status --change <名字>`：一个 change 的进度。**change 名要用 `--change` 传**，写成 `openspec status <名字>` 会报 `too many arguments`。
  - `openspec validate <名字>`、`openspec archive <名字>`、`openspec new change <名字>`、`openspec instructions <产物>`。
  - **`openspec validate` 只看 ERROR，不加 `--strict`**（指令文件里写了也去掉）：WARNING 是 OpenSpec 的写作建议，不算门禁失败。像「Requirement text is very long (>500 characters)」这种字数提醒，文档写多长按内容需要定（用户 2026-11-26 定）：不要为了消警告把接口表、边界条件从需求正文挪进 scenario，也不要删减内容；只有一条需求里真的写了几件互不相关的行为时才拆成几条。
  - 拿不准时先 `openspec <命令> --help`，不要连试几种写法。
- **斜杠指令**：`/opsx-explore`、`/opsx-propose`、`/opsx-apply`、`/opsx-archive`（`/opsx:propose` 写法是同一指令；也可能装成 `openspec-propose` 等同名技能）。它们不是 CLI，也不是 shell 命令，按当前 CLI 的指令规范执行；指令正文里提到的工具名（提问、清单、子 Agent 等）映射到当前 CLI 的等价能力，不要照字面调用不存在的工具。
- **直接改文件**：`proposal.md` / `design.md` 正文、specs 的需求条目、`tasks.md` 的勾选、`acceptance.md`、`handoff.md`。不得手工创建缺少 `.openspec.yaml` 的 change 目录，也不得手工移动目录归档。

CLI 与指令的参数和可用性以当前环境实际提供的为准，不臆造不存在的指令。

## 读写文件的小心点

- 改 `tasks.md`、`acceptance.md`、`handoff.md` 用 CLI 自带的读写、编辑文件工具，不要用 Python / PowerShell 的 heredoc 拼内容写文件：Windows 路径里的 `\U`、`\t` 在 Python 普通字符串里是转义，会直接报错或写坏（实跑踩过）。非要用脚本时路径写成原始字符串（`r"G:\..."`）或正斜杠。
- `design.md` 这类大文件按章节读：先看标题列表，再读这一阶段用得上的那几节；同一个节点里读过的不要重读整份。

## 文档产出

- **决策**：同时满足「难以逆转、缺少上下文会让后来者困惑、是真实权衡的结果」才写 ADR，写在 `DOC_ROOT/adr/NNNN-slug.md`（顺序编号，取现有最大号 +1）；不满足就留在 `design.md`。
- **验收**：证据落 `DOC_ROOT/openspec/changes/<change>/acceptance.md`。
- **项目总览**：`DOC_ROOT` 应有 `README.md`；领域术语密的项目再补 `CONTEXT.md`。
- 改代码前先读 `DOC_ROOT/adr/`，那里记的是「有意为之、不要动」的地方。
