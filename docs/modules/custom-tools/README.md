# custom-tools：自建工具

- 状态：documented
- 职责：/createtool 做出来的项目和全局工具：存取、版本、参数校验和命令展开、运行（守卫、授权、P4 签出、长任务放后台）、保存弹窗、管理页和「/」菜单
- 源码：`shared/custom-tools/`、`server/custom-tools/`、`server/panel-tools/custom-tool.ts`、`shared/api-contract/custom-tools.ts`、`web/src/components/projects/caps/tools/`
- 入口：`server/custom-tools/agent.ts`
- 关键词：自建工具、createtool、custom_tool、导表、项目工具、全局工具、ctool
- 更新：2026-11-26

为什么这么定见 [ADR 0082](../../adr/0082-custom-tools.md)，设计稿 `docs/openspec/changes/custom-tools/design.md`。

## 入口

| 文件                                              | 做什么                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/custom-tools/schema.ts`                   | 存盘格式 `CustomTool`、列表项 `ToolEntry`、`nextVersion`（版本 +1、历史最多 5 个）                                                    |
| `shared/custom-tools/expand.ts`                   | 参数校验 `checkArgs`、按 shell 加引号、展开命令、草稿问题 `draftProblems`                                                             |
| `shared/custom-tools/dup.ts`                      | 保存时的重复检测                                                                                                                      |
| `shared/custom-tools/text.ts`                     | 给 Agent 的文字：提示词清单、list / show、运行结果；「/」菜单 `tool:<id>` 的展开                                                      |
| `shared/custom-tools/match.ts`                    | 认命令里的程序名：Agent 自己跑自建工具包好的程序时，情境规则提醒改用 custom_tool；提示词清单由 `server/orch-hint.ts` 拼进各身份的说明 |
| `server/custom-tools/store.ts`                    | 读写：项目的经项目数据（P4 先签出），全局的在数据目录 `tools/`；最近一次运行                                                          |
| `server/custom-tools/run.ts`、`checkout.ts`       | 准备（脚本落盘、展开）和执行（runShell、日志、按 writes 签出）                                                                        |
| `server/custom-tools/agent.ts`                    | `custom_tool` 的五个 action：授权卡（类型 `ctool`）、后台、保存弹窗                                                                   |
| `server/custom-tools/api.ts`                      | 管理页接口：列表、保存、删除、复制 / 移动、试运行（不弹授权卡）                                                                       |
| `server/custom-tools/host.ts`                     | 开放给插件：列项目工具、起项目工具（插件自己接输出、停止），记最近一次运行                                                            |
| `web/src/components/projects/caps/tools/`         | 「技能与 MCP → 工具」页签、编辑抽屉（含试运行）                                                                                       |
| `web/src/components/tasks/CustomToolSaveCard.tsx` | 保存弹窗：选项目 / 全局、改名字说明、让 Agent 再改                                                                                    |

共用组件：`ui/scope-picker.tsx`（存到哪的单选卡片）、`ui/tool-param-form.tsx`（按参数定义出表单）、`ui/tool-run-result.tsx`（运行结果、影响小标签）。

## 怎么接

- 插件的按钮要跑一条命令时，不在插件里另配命令行，绑一个项目工具：`server/custom-tools/host.ts` 的 `projectTools` 给下拉选、`spawnProjectTool` 起进程（例：UE 插件 Lua 页的增量编译、全编译，2026-11-26）。只认项目工具，全局的只在本机、同事那边找不到。
- 新的「存到项目还是全局」的东西用 `ScopePicker`；要按参数定义出表单用 `ToolParamForm`。
- 演示后端 `web/src/lib/demo/demo-custom-tools.ts` 调 shared 里同一份校验和展开，命令不真的执行。
