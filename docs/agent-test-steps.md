# Agent 的能力块、项目测试步骤和参数配置

这份文档讲三件相关的事：内置 Agent 怎么按**能力块**划分、项目里怎么配**测试步骤**、工作流用到的 Agent 参数怎么在项目设置里配（含 AI 配置）。

## 1. 内置 Agent 按能力块划分

内置 Agent 在 `shared/builtin/agents.ts`（`BUILTIN_AGENTS`，key 稳定，装出来记在 `origin: builtin:<key>`）。
原则是**一个 Agent 管一个能力块，具体做法交给参数和项目配置**，不要按「编译 A」「跑单测」「跑 e2e」切成不同角色。

完整职责清单见 [agent-catalog.md](./agent-catalog.md)；下面是能力块和 key 的对应：

| 能力块         | key               | 说明                                                                  |
| -------------- | ----------------- | --------------------------------------------------------------------- |
| 方案设计       | `analyst`         | 收敛需求、出方案；`scale=architectural` 时出候选方案和架构契约        |
| 开发           | `developer`       | 写代码；`task` 选实现 / 修 Bug / 性能问题                             |
| **测试与验收** | `tester`          | 构建、编译、单元测试、端到端、静态检查、回归、验收结论，全在这一个里  |
| 依赖与安全     | `deps`            | 过期、漏洞、许可、破坏性变更，按批次升级并验证                        |
| 评审           | `reviewer`        | 只读评审改动或复核结论（`target`），和测试分开                        |
| 文档与交付     | `docsync` / `vcs` | 同步文档（ADR / Bug 记录由参数控制）、版本控制收尾                    |
| 调研           | `explorer`        | 只读定位代码、影响面、外部资料（`target`），UE 项目按 `stack=ue` 侦察 |

`tester` 的参数决定「怎么跑」：

| 参数      | 取值                           | 作用                                                 |
| --------- | ------------------------------ | ---------------------------------------------------- |
| `scope`   | 本次改动 / 整体                | 只跑改到的部分和受影响回归，还是全部步骤             |
| `env`     | 自动 / wsl / powershell / bash | 执行环境；自动按步骤自己标的环境和系统判断           |
| `regress` | 布尔                           | 同时查回归（读 bugs.md 和变更代码）                  |
| `onFail`  | 只报告 / 自己修                | 失败时交回日志，还是先修好再跑                       |
| `write`   | 布尔                           | 是否允许跑会写工作区的命令（格式化写回、快照更新）   |
| `serial`  | 布尔                           | 编译这类抢文件锁的步骤串行执行（UE 的 `-WaitMutex`） |

`tester` 开了「通用」（`common: true`），工作流里任何 Agent 都能把测试作为子任务派给它。

### 和旧版的关系

以前的 `verifier`（验收员）、`projecttest`（测试验证）、`ueintegrator`（UE 集成员）职责和 `tester` 重叠，已经并入；
`docs`（文档维护）并入 `docsync`，`deliver`（交付）并入 `vcs`。完整清单见 [agent-catalog.md](./agent-catalog.md)。

- 没改过的旧副本会自动升级成新定义（`shared/builtin/legacy.ts` 里的 `LEGACY_AGENT_FIELDS`）：
  `tester`、`docsync`、`vcs`、`debugger` 这次都加了参数，没动过的跟着换。
- 本机如果还有被合并 Agent 的副本，**不删除**（旧工作流可能还在引用），只在简介后面补一句「已合并到…」，见 `MERGED_AGENTS`。
- 用户改过、没被自动升级的工作流，`redirectMergedWorkflows` 会把指向被合并 Agent 的节点改成指向合并目标，
  节点说明和参数原样保留，保证还能跑；重复启动不会重复改。
- 改动前的内置 Agent 定义只用于升级判断，不要拿去给新用户装。

## 2. 项目测试步骤 `Project.testSteps`

测试步骤**属于项目**，不属于工作流：同一个工作流给不同项目用时命令不一样，不该让工作流作者在 `expose` 里重复填。

```ts
type TestStep = {
  id: string // 稳定 id，界面里排序、增删用
  name: string // 显示名，例如「类型检查」「编译」
  command: string // 要执行的命令原文
  env: 'auto' | 'wsl' | 'powershell' | 'cmd' | 'bash'
  cwd: string // 相对项目根的工作目录，空表示项目根
  when: string // 执行条件，例如「仅改了 web/ 时」
  timeoutSec: number // 0 表示不限
  merge: boolean // 合并时编译：子对话用独立 worktree 时，submit_build 把改动试合回原目录后跑这些步骤，通过才提交
  note: string // 给执行者看的说明
  enabled: boolean
}
```

- 旧项目没有这个字段时默认 `[]`，不会读坏。
- `Project.wslDistro`：标了 `wsl` 的步骤用哪个发行版，空时用 `Ubuntu-24.04`。
- 项目设置里可以增删、上下移、启停；保存到 `ProjectInput` 时按 zod 校验。

### 怎么交给 Agent

新建对话时整份步骤**快照**进任务（`TaskData.testSteps`、`TaskData.platform`），同时写成工作流说明里的
「## 项目测试步骤」一段（`shared/test-steps.ts` 的 `testStepsBlock`）。

- 只注入真的用到了测试 Agent 的工作流（按「Agent 有没有 `scope` + `env` 两个参数」判断，见 `isTestAgent`），
  评审、建模这类流程不会看到一份无关的命令。
- 之后改项目设置不影响已经开始的对话；「按最新的工作流继续」时才会换。
- 没有配置步骤时给出兜底：让 Agent 按 package.json / Makefile / CI / README 自己找，找不到就报告缺口并建议补上，**不编命令**。

### 环境怎么真正执行

`stepCommand(step, platform, wslDistro)` 把步骤写成真的能跑的命令：

| env          | Windows                                    | 其他系统            |
| ------------ | ------------------------------------------ | ------------------- |
| `wsl`        | `wsl.exe -d <发行版> -- bash -lc "<命令>"` | `bash -lc "<命令>"` |
| `powershell` | `powershell -NoProfile -Command "<命令>"`  | `pwsh ...`          |
| `cmd`        | `cmd.exe /d /c "<命令>"`                   | 原样                |
| `bash`       | `bash -lc "<命令>"`                        | `bash -lc "..."`    |
| `auto`       | 原样                                       | 原样                |

非 Windows 上标了 WSL 的步骤只能按 bash 跑，提示词里会说明「跑不了就登记为延期验证」，不能假装在 WSL 里跑过。

### 默认步骤

`defaultTestSteps(kind, { windows, scripts })` 按技术栈给一份：

- Node / TypeScript：只列 `package.json` 里**真的有的** scripts（typecheck / lint / test:unit / test:e2e / build）；
  Windows 上 `test:e2e` 标成 `wsl`。
- UE：编译（`Build.bat <Target> Win64 Development -Project=<.uproject> -WaitMutex`）、Lua 语法检查、可选的 AutomationTest（默认停用）。
- Rust / Go / Python / .NET / CMake 各给常用的检查、测试、构建。

「AI 分析这个目录」（`POST /projects/analyze`）会把这份默认步骤一起填进表单，用户确认保存后才生效。

## 3. 项目设置里的 Agent 参数

### 派生，不用手填

以前要在 `Workflow.expose` 里手工加 `target: agent` 的一条。现在改成**按项目当前工作流实际用到的 Agent 派生**：

`shared/agent-params.ts` 的 `derivedParams(workflow, agents)`：

1. 收集主 Agent + 所有节点 / 步骤里的 Agent（去重）。
2. 收集它们的 `AgentParam`。
3. **同一个 key 只出现一次、共用一个值**，并记下影响哪些 Agent（界面上显示「同时影响 …」）。
4. 工作流 `expose` 里 `target: agent` 已经管着的 key 不再派生，避免同一参数有两套配置源。

界面按 Agent 分组渲染（`ProjectSettingsDialog` 的 `AgentParamsEditor`）：主 Agent 在前，其余按名称排。
默认值来自 `AgentParam.default`，留空即用默认；`ask: true` 且没有默认值的标「必须填」。

### 值存在哪、怎么生效

- 值仍然按「项目 × 工作流」存：`Project.workflowParams[workflowId][key]`。切换工作流后表单跟着变，已填的值不丢。
- 新建对话时（`taskSnapshot` → `applyExpose(w, params, agents)`）合并进节点 / 步骤参数，优先级：
  **节点上原来的值 < 项目里填的 Agent 参数 < `Workflow.expose`（target=agent，最具体）**。
- 只写这个 Agent 真的声明了的参数，不会把无关参数塞进节点。
- 快照定下来后改项目设置不影响已经开始的对话。

### AI 配置按钮

项目设置里有三个入口，都在**项目目录里只读分析**（不是临时目录）：

| 位置              | kind        | 作用                                                  |
| ----------------- | ----------- | ----------------------------------------------------- |
| 每个 Agent 分组旁 | `params`    | 配这个 Agent 暴露的所有参数（`subject.agentId` 限定） |
| 工作流配置区      | `params`    | 配整个工作流涉及的所有参数                            |
| 测试步骤区        | `teststeps` | 分析项目，生成 / 补全测试步骤                         |

实现：

- `shared/assist.ts` 的 `AssistKind` 增加了 `params` / `teststeps`；提示词在 `buildParamsPrompt` / `buildTestStepsPrompt`，
  写死只读约束（不改文件、不装依赖、不跑有副作用的命令，需要跑命令时先说明并等用户确认）。
- `server/assist.ts` 用 `AssistInput.projectId` 取项目目录，在项目目录里执行 CLI，并改用 CLI 的只读权限（`def.readOnly`）。
- 输出沿用「正文说明 + 一个 ```json 代码块」的约定；`resolveParamValues`/`resolveTestSteps` 按类型校验
  （select 必须在 options 里，bool 是布尔，number 是数字，多选是字符串数组），不通过时自动让 CLI 修正一次。
- AI 结果只填进项目设置的表单草稿，用户点「确认」保存后才生效；取消不改数据。

## 4. 已装副本的升级

内置 Agent 和工作流只在添加时创建，所以要处理老机器上的旧副本（`shared/builtin/install.ts`）：

- `upgradeBuiltinWorkflows`：按 `origin` + 语义比较（节点、连线、说明，忽略坐标），和 `LEGACY_WORKFLOWS` 里的旧定义一致才升级；
  保留 id、名称、分类、标签和节点坐标。用户改过的不覆盖。
- `upgradeBuiltinAgents`：Agent 的 name / description / instructions 和 `LEGACY_AGENT_FIELDS` 完全一致才升级到新定义。
- `annotateMergedAgents`：已合并的 Agent 在本机还有副本时补一句说明，幂等。
- `redirectMergedWorkflows`：用户改过、没被整体升级的工作流，把指向被合并 Agent 的节点换成合并目标，幂等。
- 升级后结构不再匹配旧定义，**重复启动不会重复改**。

用户改过的副本不会被覆盖，旧工作流引用已合并的 Agent 时仍然能运行（Agent 还在，只是不再出现在「内置」里）。
建议重新添加工作流或手动同步节点引用。

## 5. 加新的升级时

1. 把即将被替换掉的旧流程 / 旧 Agent 字段原样追加到 `shared/builtin/legacy.ts`
   （`LEGACY_WORKFLOWS[key]` 数组的**最后**；Agent 的旧字段进 `LEGACY_AGENT_FIELDS`）。
2. 被合并掉的 Agent 记进 `MERGED_AGENTS`：老机器上的副本会补说明，用户改过的工作流会被重定向到合并目标。
3. 确认 `server/builtin.test.ts` 里的升级测试覆盖「没改过的会升级、改过的不动、重复启动不再改」。
4. 新增 Agent 或工作流前，先对照 [agent-catalog.md](./agent-catalog.md) 的判定标准和职责清单，
   确认现有 Agent 确实做不了，并在清单里补一行。

## 相关代码

| 文件                                                    | 内容                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `shared/builtin/agents.ts`                              | 内置 Agent 定义（能力块）                                    |
| `shared/builtin/workflows.ts`                           | 内置工作流；`EXTRA_WORKFLOWS`、`buildFlow` / `buildWorkflow` |
| `shared/builtin/legacy.ts`                              | 旧定义（升级判断）、已合并的 Agent 说明                      |
| `shared/builtin/install.ts`                             | 安装、升级、迁移、已合并 Agent 的重定向                      |
| `shared/agent-params.ts`                                | 按工作流派生 Agent 参数、同 key 合并                         |
| `shared/test-steps.ts`                                  | 测试步骤默认值、命令行写法、提示词片段                       |
| `shared/expose.ts`                                      | `applyExpose`：项目值 → 节点参数 → 快照                      |
| `shared/assist.ts`                                      | AI 配置的提示词和校验（params / teststeps）                  |
| `server/assist.ts`                                      | AI 配置的执行（项目目录只读）                                |
| `web/src/components/projects/ProjectSettingsDialog.tsx` | 项目设置：测试步骤、Agent 参数、AI 按钮                      |
| `server/agent-params.test.ts`                           | 派生、合并、快照、步骤校验、AI 结果校验的测试                |

## 子对话的隔离和合并编译

项目设置「常规 → 子对话」选隔离方式，默认「独立 worktree」：

- worktree 要改文件时才建：子对话第一次执行时只记下 `wantsWorktree`，先在父对话所在的目录里看代码；
  要改文件时调用 `begin_edit`，面板这时从那个目录建 worktree，这一轮结束后在 worktree 里开新会话、带上之前的对话接着做
  （`task.sessionDir` 和当前目录不一样就不续接旧会话）。还没建时 Claude Code 关掉改文件的工具（`BuildOptions.noEdit`）。
- 顶层对话勾了「独立分支」也一样（项目设置「独立分支」可以设成默认勾上）；工作流任务创建时就建好。
- worktree 完整检出，只有目录里有 `.uproject` 的大项目跳过 LFS 内容。只用来隔离文件编辑。
- 子对话改完调用 `submit_build`：面板提交它的分支，排队试合回**建 worktree 的那个目录、那个分支**（不限定 dev），
  在原目录跑勾了「合并时编译」的步骤；通过才提交合并，失败撤回、原目录不变。结果推回子对话，同时告诉父对话。
- 选「共用目录 + 认领文件」时，子对话都在项目目录里改，先 `claim_files` 认领，编译一次只跑一个。

长命令（完整测试、编译）可以用 `run_background` 交给面板在后台跑，CLI 先去做别的，跑完结果自动推回对话；
标成独占的命令按目录排队，跑的期间文件变了会提醒结果可能不准。
