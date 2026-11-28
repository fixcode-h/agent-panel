# custom-tools：自建工具

- 状态：documented
- 职责：/createtool 做出来的项目和全局工具：存取、版本、参数校验和命令展开、运行（守卫、授权、P4 签出、长任务放后台）、保存弹窗、管理页和「/」菜单
- 源码：`shared/custom-tools/`、`server/custom-tools/`、`server/panel-tools/custom-tool.ts`、`server/panel-tools/custom-tool-direct.ts`、`shared/api-contract/custom-tools.ts`、`web/src/components/projects/caps/tools/`
- 入口：`server/custom-tools/agent.ts`
- 关键词：自建工具、createtool、custom_tool、tool_<id>、直接调用、导表、项目工具、全局工具、ctool、role、校验工具、replaces、程序位置、locate、luac 路径
- 更新：2026-11-28

为什么这么定见 [ADR 0082](../../adr/0082-custom-tools.md)（用途 `role` 见 [ADR 0086](../../adr/0086-verify-and-apply.md)），设计稿 `docs/openspec/changes/custom-tools/design.md`。

## 入口

| 文件                                              | 做什么                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/custom-tools/schema.ts`                   | 存盘格式 `CustomTool`、列表项 `ToolEntry`、`nextVersion`（版本 +1、历史最多 5 个）                                                                   |
| `shared/custom-tools/expand.ts`                   | 参数校验 `checkArgs`、按 shell 加引号、展开命令、草稿问题 `draftProblems`                                                                            |
| `shared/custom-tools/dup.ts`                      | 保存时的重复检测                                                                                                                                     |
| `shared/custom-tools/direct.ts`                   | 直接调用（ADR 0082 修订）：每个工具列成 `tool_<id>`、参数 schema、直接列出的那几个（最多 12 个）、提示里怎么写调用（`callHint`）、对话里那一行的标题 |
| `server/panel-tools/custom-tool-direct.ts`        | 面板工具注册表的动态工具来源：清单取这一轮的 `o.customTools.tools`，执行走 `callCustom`（和 `custom_tool action=run` 同一条路）                      |
| `shared/custom-tools/text.ts`                     | 给 Agent 的文字：提示词清单、list / show、运行结果；「/」菜单 `tool:<id>` 的展开                                                                     |
| `shared/custom-tools/match.ts`                    | 认命令里的程序名：Agent 自己跑自建工具包好的程序时，情境规则提醒改用 custom_tool；提示词清单由 `server/orch-hint.ts` 拼进各身份的说明                |
| `server/custom-tools/store.ts`                    | 读写：项目的经项目数据（P4 先签出），全局的在数据目录 `tools/`；最近一次运行                                                                         |
| `server/custom-tools/run.ts`、`checkout.ts`       | 准备（脚本落盘、展开）和执行（runShell、日志、按 writes 签出）                                                                                       |
| `server/custom-tools/agent.ts`                    | `custom_tool` 的六个 action：授权卡（类型 `ctool`）、后台、保存弹窗；`locate` 登记程序位置                                                           |
| `server/custom-tools/api.ts`                      | 管理页接口：列表、保存、删除、复制 / 移动、试运行（不弹授权卡）                                                                                      |
| `server/custom-tools/host.ts`                     | 开放给插件：列项目工具、起项目工具（插件自己接输出、停止），记最近一次运行                                                                           |
| `web/src/components/projects/caps/tools/`         | 「技能与 MCP → 工具」页签、编辑抽屉（含试运行）                                                                                                      |
| `web/src/components/tasks/CustomToolSaveCard.tsx` | 保存弹窗：选项目 / 全局、改名字说明、让 Agent 再改                                                                                                   |

共用组件：`ui/scope-picker.tsx`（存到哪的单选卡片）、`ui/tool-param-form.tsx`（按参数定义出表单）、`ui/tool-run-result.tsx`（运行结果、影响小标签）。

## 怎么接

- 插件的按钮要跑一条命令时，不在插件里另配命令行，绑一个项目工具：`server/custom-tools/host.ts` 的 `projectTools` 给下拉选、`spawnProjectTool` 起进程（例：UE 插件 Lua 页的增量编译、全编译，2026-11-26）。只认项目工具，全局的只在本机、同事那边找不到。
- 新的「存到项目还是全局」的东西用 `ScopePicker`；要按参数定义出表单用 `ToolParamForm`。
- 演示后端 `web/src/lib/demo/demo-custom-tools.ts` 调 shared 里同一份校验和展开，命令不真的执行。

## 用途 role（ADR 0086）

- `role: { kind: 'verify' | 'build', paths, replaces, arg?, listFile }`，可选，编辑抽屉「用途」页（`RoleTab.tsx`）能改，列表行上有「校验」「编译」徽标。
- verify：工具网关在 Agent 改完对得上 `paths` 的文件、去做别的事时自己跑它（`server/tool-gateway/verify/`），只推报错；必须 `effect: read`，`draftProblems` 会拦。改过的文件填进 `arg`（不写用第一个 path 参数），`listFile` 写成清单一次跑完。
- `replaces`：`customToolSigs` 收进 `CustomToolSig.replaces`，网关改道时 Agent 跑这些程序改走这个工具，观察模式下情境规则 `custom-tool-instead` 也认它。
- build：能力「改动生效」的一条路，UE 编译命令在没挂 `request_build` 的对话里改用它。

## 程序位置（locate，2026-11-26）

- 为什么：luac、导表工具这类程序不在 PATH 里，每个节点都重新全盘找，经验里记过路径也没人用（OpenSpec 实跑复盘 2 的 P2-4、§5 第 4 项）。
- Agent 找到后调 `custom_tool action=locate program=<名字> path=<完整路径>` 登记；只写 program 是查，`forget=true` 删。人在「技能与 MCP → 工具」的「程序位置」一块看、改、删、自己登记（`ProgramPathsBlock.tsx`）。
- 存 `<数据目录>/program-paths.json`，按项目 id 分组：路径只在这台电脑上，不进项目文档、不进仓库。登记时查文件在不在，列出时文件不在了的标 `missing`、不再推给 Agent。
- 用到它的两处：`customToolsFor` 的提示词那一行末尾带上 `programsHint`（每个对话开头都看得到）；情境规则 `program-located`（`shared/hooks/situational.ts`）在 Agent 又用 find / where / Get-ChildItem 找已登记的程序时直接给路径。
- 纯逻辑（登记覆盖、上限、检查、认「在找程序」的命令）在 `shared/custom-tools/programs.ts`，服务端 `server/custom-tools/programs.ts` 和演示后端 `demo-program-paths.ts` 共用。
