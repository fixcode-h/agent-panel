# ADR 0025：模型设计接入 Blender，对话驱动建模、网页实时预览

- 状态：提议
- 日期：2026-10-29

## 背景

设计模式原来只有 UI 设计（控件树 + 原画 + 切图）。用户要求加「模型设计」，并且「优先考虑接入 Blender，使用 Blender 建模，在网页端可以实时看到」。
要定的是三件事：模型设计挂在哪种数据上、Agent 怎么操作 Blender、网页怎么「实时看到」。

## 事实核对

| 位置                                                           | 现状                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/design-mcp.ts` 的 `openDesignSession` / `designMcpApi` | UI 设计的工具是面板自己起的 MCP 服务（Streamable HTTP，`/api/mcp/design/<令牌>`），手写 JSON-RPC：`initialize` / `tools/list` / `tools/call`              |
| `server/designs.ts` 的 `chat()`                                | 设计对话自己管 job、插话、排队、版本，数据是控件树（`shared/design.ts` 的 `Design`），和模型无关                                                          |
| `server/exec/invoke.ts` 的 `invokeCli`                         | 选项 `mcp?: { name; url }[]` 会按 CLI 定义（`shared/cli-spec.ts` 的 `mcpConfig`）把额外的 MCP 服务交给 CLI；对话执行（`server/exec/runner.ts`）目前没有传 |
| `shared/schema.ts` 的 `Task`                                   | 对话已有 `analysis` 这类「对话用途」的标记，界面按它加标签、换面板                                                                                        |
| `web/src/components/tasks/TaskFiles.tsx`                       | 右栏是固定页签条（项目文件 / 本对话改动），加一个页签不动布局                                                                                             |
| PyPI `bpy`                                                     | 有 5.x 的 Blender Python 模块（Python 3.13），可以不装 Blender 本体在测试里跑同一份桥接脚本                                                               |

## 决策

1. **模型设计是一种对话**：`Task.modelDesign = true` 的项目对话，不新建一种设计数据。
   - 理由：对话已经有 CLI / 角色 / 插话 / 提问 / 子对话 / 页签，模型设计要的正是这些；UI 设计的 `Design` 数据和流程全是控件树专用的，套进去要改一大片。
   - 放弃：在 `shared/design.ts` 里加 `kind: 'model'`。那样要把 `designs.ts` 的 job、版本、导出全部按种类分支。
2. **Blender 在后台跑，由面板起停**：每个模型对话一个 Blender 进程（`blender -b --factory-startup --python server/blender/bridge.py`），桥接脚本在 Blender 里起一个只听本机的 HTTP 服务，面板用它执行 Python、读场景、导出。场景存在数据目录 `models/<对话 id>/scene.blend`，重开时接着用。
   - 放弃：让用户自己开着 Blender 装插件、面板连它的端口（blender-mcp 那种）。要用户先开软件、装插件、保持开着；可以以后作为「连接正在运行的 Blender」补上。
3. **Agent 用 MCP 工具写 bpy 代码建模**：`/api/mcp/blender/<令牌>` 提供 `blender_python`（在当前场景里运行一段 bpy 代码）和 `blender_scene`（列出物体、尺寸、面数、材质）。代码能做的事 Blender 都能做，不需要为每种操作单独设计工具。
   - 放弃：一种操作一个工具（加立方体、加修改器…）。Blender 的能力太多，列不全，模型对 bpy 本来就熟。
4. **网页实时看到 = 每次改动后导出 glb，网页用 three.js 显示**：工具每成功执行一次，面板保存 `.blend`、导出 `scene.glb`、版本号加一；右栏「模型」页签轮询版本号，变了就重新加载，视角保持不动，可以转、缩放、平移。
   - 放弃：Blender 渲染截图给网页。后台没有显卡时渲染慢甚至失败，而且只能看一个角度。

## 操作清单 / 契约

| 项                                 | 内容                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置                               | `Settings.blender.path`：Blender 可执行文件；空时按 PATH 和常见安装位置找                                                                                                          |
| 桥接（`server/blender/bridge.py`） | `POST /exec {code}` → `{ ok, output, error }`；`GET /scene` → 物体列表；`POST /export {path}` 导出 glb；`POST /save {path}` 存 .blend；只监听 127.0.0.1，启动后打印 `READY <端口>` |
| 进程管理（`server/blender.ts`）    | 按对话起一个桥接进程，空闲 10 分钟关掉；执行成功后保存、导出、`version + 1`                                                                                                        |
| MCP（`/api/mcp/blender/<令牌>`）   | `blender_python { code }`、`blender_scene {}`；令牌只在这一轮有效                                                                                                                  |
| 对话执行                           | `Task.modelDesign` 为真时 `runner` 给 `invokeCli` 传 `mcp: [{ name: 'blender', url }]`，提示词里说明工具和约定（单位米、Z 轴向上、物体起好名字）                                   |
| 接口                               | `GET /api/tasks/:id/model` → `{ version, objects, updatedAt }`；`GET /api/tasks/:id/model.glb`                                                                                     |
| 界面                               | 设计模式顶部下拉切换「UI 设计 / 模型设计」；模型设计按项目列模型对话、新建；对话右栏多一个「模型」页签（three.js 预览）                                                            |

## 影响与风险

- 用户机器上要装 Blender（4.2+）；没装时设置里写清怎么装，新建模型对话前就提示，不等到执行时报错。
- Agent 写的 bpy 代码在用户本机的 Blender 里跑，和 Agent 在项目里执行命令同一级别的信任；桥接只听本机、令牌按轮次失效。
- glb 导出丢掉 Blender 专有的东西（几何节点未应用的修改器、程序化材质），预览以导出结果为准；`.blend` 是原件，导出到项目时两样都给。
