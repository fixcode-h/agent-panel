# Agent 的能力块、项目测试步骤和参数配置

这份文档讲三件相关的事：内置 Agent 怎么按**能力块**划分、项目里怎么配**测试步骤**、工作流用到的 Agent 参数怎么在项目设置里配（含 AI 配置）。

## 1. 内置 Agent 按能力块划分

内置 Agent 在 `shared/builtin/agents.ts`（`BUILTIN_AGENTS`，key 稳定，装出来记在 `origin: builtin:<key>`）。
原则是**一个 Agent 管一个能力块，具体做法交给参数和项目配置**，不要按「编译 A」「跑单测」「跑 e2e」切成不同角色。

完整职责清单见 [agent-catalog.md](./agent-catalog.md)；下面是能力块和 key 的对应：

| 能力块         | key               | 说明                                                                                  |
| -------------- | ----------------- | ------------------------------------------------------------------------------------- |
| 方案设计       | `analyst`         | 收敛需求、出方案；`scale=architectural` 时出候选方案和架构契约                        |
| 开发           | `developer`       | 写代码；`task` 选实现 / 修 Bug / 性能问题                                             |
| **测试与验收** | `tester`          | 构建、编译、单元测试、端到端、静态检查、回归、验收结论，全在这一个里                  |
| 依赖与安全     | `deps`            | 过期、漏洞、许可、破坏性变更，按批次升级并验证                                        |
| 评审           | `reviewer`        | 只读评审改动或复核结论（`target`），和测试分开                                        |
| 文档与交付     | `docsync` / `vcs` | 同步文档（ADR / Bug 记录由参数控制）、版本控制收尾                                    |
| 调研           | `explorer`        | 只读定位代码、影响面、外部资料（`target`，可回写模块文档），UE 项目按 `stack=ue` 侦察 |

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

- 内置角色的副本每次启动都按当前定义同步（[ADR 0015](adr/0015-builtin-roles-follow-definition.md)），参数取值保留。
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
  appliesTo: string[] // 适用改动：改动清单里有文件匹配这些 glob 才跑；空数组表示总是执行
  when: string // 补充说明，写给人看的，例如「仅发布前跑」；判定以 appliesTo 为准
  timeoutSec: number // 0 表示不限
  merge: boolean // 合并时编译：子对话用独立 worktree 时，submit_build 把改动试合回原目录后跑这些步骤，通过才提交
  quick: boolean // 小改动也跑：Agent 判断是小改动时只跑这些（类型检查、lint 这类快的）
  note: string // 给执行者看的说明
  enabled: boolean
}
```

- 旧项目没有这个字段时默认 `[]`，不会读坏；老步骤的 `appliesTo` 是空数组，表示**总是执行**，升级不会漏跑。
- `Project.wslDistro`：标了 `wsl` 的步骤用哪个发行版，空时用 `Ubuntu-24.04`。
- 项目设置里可以增删、上下移、启停、填「适用改动」；保存到 `ProjectInput` 时按 zod 校验。

### 按改动范围筛选（`appliesTo`）

测试只做有意义的那几条：UE 没改 C++ 就不编译 C++，C# 没动过就不跑 `dotnet build`。

- **匹配算法只有一份**：`shared/test-steps.ts` 的 `matchesGlob` / `stepApplies(step, changedFiles)`。
  界面的输入解析（`parseGlobs`）、交给 Agent 的提示词（`appliesToText`）、单测都读它，不在前端或别的地方再写一套 glob 判断。
  真正的比对由 Agent 按提示词里的改动清单做（执行流程里目前还没有按清单自动跳过的地方）。
- **glob 语法**：相对项目根的路径，支持 `**`（跨目录）、`*`、`?`；`**/*.cpp` 也认仓库根下的 `a.cpp`；
  没写通配符的写法按「精确命中或目录前缀」算（`web/src` 和 `web/` 都等价于 `web/src/**`、`web/**`）——
  项目教训里习惯写 `src/payment/**` / `web/src` 这种，照抄进来不会变成永远匹配不上的规则。
  界面上用逗号（中英文都认）分隔，由 `parseGlobs` 切分（最多 30 条，和 schema 的上限一致）。
- **改动清单的口径是「这次任务实际波及的改动」**，不是只看自己那几个 commit：
  - Git：`git diff --name-only <任务基线>...HEAD`（三点比较，含合并进来的内容）再加上 `git status --short` 里的工作区改动；
  - Perforce：`p4 opened` 加上 `p4 diff` 里本次涉及的文件；其它版本控制按项目自己的约定。
  - **拉取 / 合并远端更新后按合并后的清单重新判断**：合并进来的文件也算本次改动，涉及的步骤要正常执行，
    不能以「这部分不是我改的」为理由跳过——只按自己的提交判断会把别人合进来的 C++ 改动漏掉。
- 一个步骤的 `appliesTo` 和清单**完全不匹配才跳过**，跳过的要在验收结论里写一行
  「跳过：步骤名 — 本次及合并进来的改动都没有 X（实际改的是 …）」；一条都不匹配时写
  「本次改动不涉及配置的测试步骤 — 本次改的是 …」，不能默默什么都不说。
- **取不到改动清单时按总是执行**：项目没有版本控制、命令失败、不知道任务基线时，清单是空的，
  未知不等于不相关——宁可多跑也不能静默漏跑，同时要在结论里说明这次为什么没筛。
  `stepApplies(step, [])` 同样返回 `true`，口径只有这一处。
- 禁止「为了保险把所有步骤都跑一遍」：没匹配上的步骤跑了不算验证，还拖时间。
  有 `merge: true` 的编译被选中时，仍然遵守「同一时间只编译一次」；这类步骤在提示词的步骤行里标「合并时编译」。
- **范围是「整体」时不筛**：发布前验证、整体验收、依赖升级后确认步骤这几类节点把范围参数写成 `整体`
  （`shared/builtin/workflows.ts` 里硬编码），它们的存在意义就是不按改动清单筛——按步骤顺序全跑，
  跳过的只能因为环境跑不了（需要 Editor、需要别的系统），不能写「本次没改 X」。`CHANGED_FILES_RULE` 第 0 条
  写了这条优先级，和测试角色里 `{{#if scope=本次改动}}` 的分支一致。
- 没写 `appliesTo` 的步骤（老项目升级上来的、用户新加的）表示总是执行。
- **升级提示**：以前把条件写在 `when` 里的步骤（例如「仅改了 web/ 时」），升级后 `appliesTo` 是空数组，
  按「总是执行」处理——不会漏跑，但那条文字条件已经不再生效。要恢复原来的筛选，把条件改填到「适用改动」里；
  `when` 现在只当人看的补充说明。

`shared/builtin/agents.ts` 里测试角色（`tester`）的角色设定也写了同一条规则，
但**真正带规则的是注入的提示词**（`testStepsBlock` 的 `CHANGED_FILES_RULE`），角色设定只是强调。

端到端分片 `scripts/e2e/08-test-steps.mjs` 只保证「规则交到了角色手上」（提示词里有清单口径、合并口径、跳过要求），
fake-cli 不会真的算 diff、跑命令；判定本身（哪条步骤匹配哪批文件、含「只改了文档但合并进来 C++ 改动」）
由 `shared/test-steps.test.ts` 用真实改动清单钉住。行为层的覆盖等判定接进执行流程后再补。

### 怎么交给 Agent

新建对话时整份步骤**快照**进任务（`TaskData.testSteps`、`TaskData.platform`），同时写成工作流说明里的
「## 项目测试步骤」一段（`shared/test-steps.ts` 的 `testStepsBlock`）。

- 只注入真的用到了测试 Agent 的工作流（按「Agent 有没有 `scope` + `env` 两个参数」判断，见 `isTestAgent`），
  评审、建模这类流程不会看到一份无关的命令。
- 之后改项目设置不影响已经开始的对话；「按最新的工作流继续」时才会换。
- 没有配置步骤时给出兜底：让 Agent 按 package.json / Makefile / CI / README 自己找，找不到就报告缺口并建议补上，**不编命令**。

### 按改动大小决定验证范围

参照 Claude Code：小改动跑完快速检查就收尾，不跑全量测试。`Project.scaledVerify`（默认开）控制，
项目里的对话（父对话、子对话）提示里带「验证按改动大小定」一段（`verifyBlock`，`EngineHost.verify`）：

- 小改动（文案、样式、注释、文档、配置值，一两个文件几十行内的局部修改，不动接口 / 数据结构 / 执行流程 / 构建配置 / 依赖）
  只跑 `quick` 的步骤；一条都没标就让 Agent 挑一个最快的检查。拿不准、快速检查没过都按大改动。
- 大改动跑完整步骤，或者走带测试验收的工作流。工作流里的测试验收节点不受这个开关影响。
- 两种大小都先按 `appliesTo` 筛掉不适用的步骤（「先看改动再决定跑哪些」）：小改动是「在适用的步骤里只跑 `quick` 的」，
  不是「直接跳过编译类步骤」；跳过的都要写清原因。
- 独立分支的子对话调用 `submit_build` 时传 `small: true`，合并编译只跑同时标了 `merge` 和 `quick` 的步骤
  （`mergeStepsFor`）；一条都没有时照常跑全部合并步骤，不会因为没配过而少编译。结果里写明跳过了哪些。
- 关掉开关时提示改成「每次都跑完整步骤」，`small` 也不再生效。

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
  Windows 上 `test:e2e` 标成 `wsl`。`appliesTo` 取源码 glob（`**/*.ts`、`**/*.tsx`…）加清单文件：
  类型检查还看 `**/tsconfig*.json`、`**/package.json`，lint 另加 js / jsx / mjs / cjs / css / json / md / yml，
  构建另加 js / jsx / mjs / css / html / json。纯 JS 项目（只有 `.js` / `.jsx` / `.cjs`）改源码时单测、端到端、
  构建同样要跑，所以这几个 glob 也进 `nodeRun` 和 `node-build`——只有类型检查不认它们（tsc 不编纯 JS）。
- UE：编译（`Build.bat <Target> Win64 Development -Project=<.uproject> -WaitMutex`）适用于
  `**/*.cpp`、`**/*.h`、`**/*.inl`、`**/*.cs`、`**/*.uproject`、`**/*.uplugin`——UBT 按 Build.cs / Target.cs
  生成编译规则、按 .uproject / .uplugin 找模块和插件，改了就得重编；只改资源（`.uasset` / `.umap`）或
  配置（`.ini`）时不编译。Lua 语法检查（`luac -p`，不生成 `.luac`）只看 `**/*.lua`；
  可选的 AutomationTest 默认停用，适用范围是 `**/*.cpp`、`**/*.h`（测试本身是 C++ 写的）。
- Rust / Go / Python / .NET / CMake 各给常用的检查、测试、构建，`appliesTo` 取源码加清单文件
  （Cargo.toml / Cargo.lock、go.mod / go.sum、pyproject.toml / pytest.ini / requirements.txt、
  csproj / sln / props / targets、`**/CMakeLists.txt` / `**/*.cmake`）；`cargo fmt --check` 只看 `**/*.rs`。

「AI 初始化项目」先用 `POST /projects/analyze` 快速扫一遍（这份默认步骤当线索），再让本机 Agent 在项目目录里写 AGENTS.md 和文档框架（`skills/docs/project-documentation`），评估工作流、推荐测试步骤和项目设置（`shared/project-init.ts`）。推荐项在项目设置的「AI 初始化」页逐项或整体应用，用户确认保存后才生效；`Project.initializedAt` 为空的项目（含旧项目）不能保存设置。

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

### 参数联动

`AgentParam` 可以按**排在前面**的参数决定自己（`shared/agent-role.ts` 的 `resolveParams` 从上往下算）：

- `when`：显示条件，`{ key, values, not }`。前面参数取 `values` 里任一值时成立，`values` 为空表示「有值」，开关写 `'true'` / `'false'`。
  不成立时这个参数**隐藏**：不问、不算缺、值按空处理（开关是关、单选是空），角色设定里 `{{#if key}}` 不成立，「本次的参数」里也不列。
- `optionsBy`：选项跟随，`{ key, map }`。前面参数取 `map` 里的某个值时只能选对应的选项；没列的取值不限制；对应空数组表示这时不适用（同样隐藏）。
  给的值或默认值不在缩小后的选项里时，单选退到第一个可选项（要问用户的仍然问），多选去掉不能选的。
- 依赖的参数自己被隐藏了，依赖它的也跟着隐藏；依赖排在后面或不存在的参数时规则不算数，编辑页标红提醒。
- 对话输入框、工作流节点、项目设置（按 Agent 自己的参数顺序算）、AI 配参数的提示词都按同一套规则；角色页的参数改名会同步改规则和角色设定里的 `{{旧名}}`。
- 内置角色里用到的例子：版本控制的「Git 工作区模式 / 合并方向」只在工作区不是 P4 / SVN / 无时显示；调研的「UE 侦察方向」只在技术栈是 ue 时显示。

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

- `upgradeBuiltinWorkflows`：副本记了指纹（`builtinHash`）的，内容还是那个指纹就升级；没记过的按 `origin` + 语义比较
  （节点、连线、说明，忽略坐标），和 `LEGACY_WORKFLOWS` 里的旧定义一致才升级，和当前定义一致的补记指纹。
  保留 id、名称、分类、标签和节点坐标。用户改过的不覆盖。
- `upgradeBuiltinAgents`：内置角色无条件按当前定义同步（ADR 0015），覆盖了用户改过的副本时交给调用方备份。
- `annotateMergedAgents`：已合并的 Agent 在本机还有副本时补一句说明，幂等。
- `redirectMergedWorkflows`：用户改过、没被整体升级的工作流，把指向被合并 Agent 的节点换成合并目标，幂等。
- 升级后结构不再匹配旧定义，**重复启动不会重复改**。

用户改过的工作流副本不会被覆盖，旧工作流引用已合并的 Agent 时仍然能运行（Agent 还在，只是不再出现在「内置」里）。
建议重新添加工作流或手动同步节点引用。

## 5. 加新的升级时

1. 改内置角色不用登记旧版本（每次启动直接同步）。改内置工作流时，已经记了指纹的副本自动升级；
   为了还没记过指纹的老副本，仍把即将被替换掉的旧流程原样追加到 `LEGACY_WORKFLOWS[key]` 数组的**最后**。
2. 被合并掉的 Agent 记进 `MERGED_AGENTS`：老机器上的副本会补说明，用户改过的工作流会被重定向到合并目标。
3. 确认 `server/builtin.test.ts` 里的升级测试覆盖「没改过的会升级、改过的不动（工作流）、重复启动不再改」。
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

### UE 项目：编译归父对话

项目目录（或仓库根）里有 `.uproject` 时，编译不在子对话里做（[ADR 0004](./adr/0004-ue-build-by-parent.md)）：

- 子对话只改代码、做不用编译的检查。有独立分支的 `submit_merge` 带 `build`（默认 true），合回后面板替它向父对话申请；共用目录的用 `request_build`。
- 父对话收到申请（或用户要求）才调用 `request_build`：面板跑勾了「合并时编译」的步骤（没有就认名字带「编译」的），排进后台独占队列。
- 占位按编译目录：同一目录同一时间只编译一次，别的父对话占着时排在后面，双方都会收到说明；各自 worktree 的目录互不占位。
- 子对话和父对话用 `run_background` 跑 Build.bat、UBT、UHT、RunUAT、Editor 都会被拒绝，不能绕过排队。
- 父对话之间用 `list_peers` / `message_peer` 协调。

长命令（完整测试、编译）可以用 `run_background` 交给面板在后台跑，CLI 先去做别的，跑完结果自动推回对话；
标成独占的命令按目录排队，跑的期间文件变了会提醒结果可能不准。

### 子对话收尾：评审是计划里的独立步骤

有独立分支的子对话按这个顺序收尾：改完 → 跑快速检查（项目测试步骤里标「快速」的）→ **评审（计划里单独一条主步骤，标 `review: true`）** → 逐条核实高级、中级意见并处置（要改的同样单列一步）→ 必要时复看（新的独立评审步骤，接着上次评审的会话）→ 完整测试/编译 → `submit_merge`（带 `review_triage`）。

- 评审步骤要有状态：派「评审」（`spawn_agents` 的 agent 写「评审」）时标等待中，拿回结论后标完成。
- `submit_merge` 前校验计划里有没有标 `review` 的步骤、那一步是否完成、最近一次评审写没写结论，以及它列的高级、中级是否每条都有处置（`shared/review-gate.ts`，[ADR 0009](adr/0009-review-findings-triaged.md)）；缺任何一项都会被拒绝并在交回说明里写清原因。
- 评审只做代码层面的审查：不改文件、不跑测试和构建、不搭测试环境、不写测试脚本；git 仓库里面板把改动（文件列表 + 每处改动前后几行的差异，只取这个对话改过的文件）一次附进它的提示词，复看只附增量（[ADR 0010](adr/0010-review-code-only.md)）。派评审要带交接单 `review`（第一次 `goal`、`checks` 必填），评审只评差异里改动的行，不读模块文档、不搜项目，读代码最多 3 次，跑到 6 分钟面板提醒它交卷（[ADR 0013](adr/0013-review-diff-only-with-brief.md)）。
- 意见分四级：🔴 高级（必须改，判不通过）、🟠 中级（应该改，要处置）、🟡 低级（可以改）、💡 建议（这一轮不做）。
