---
name: ue-multi-agent-coordination
description: 协调 Unreal Engine 项目中的多 Agent 并行工作，避免共享工作区、UE Editor、UBT/UHT、Cook、DerivedDataCache 和中间产物发生竞争。涉及 UE 多 Agent、UE worktree、并行编译、编辑器占用、共享工程、资源锁或构建排队时使用。
user-invocable: true
---

# Unreal Engine 多 Agent 协调

## 核心判断

Unreal Engine 项目默认不是适合无约束 Git worktree 并行的项目。worktree 只隔离 Git 文件，不隔离以下共享资源：

- 正在运行的 `UnrealEditor`、`UnrealEditor-Cmd`、`UnrealBuildTool`、`UnrealHeaderTool`、AutomationTool 和编译器进程；
- 项目级 `.sln`、`.uproject`、`.uplugin`、`Config`、`Intermediate`、`Binaries`、`Saved`、`DerivedDataCache` 以及插件生成物；
- 机器级或用户级 Unreal 配置、凭据、设备、Shader 编译、DDC 和文件锁；
- 同一项目的 C++、反射头、模块二进制和热重载状态；
- 共用 Perforce/Git 工作区中的源码、资源、重定向器和自动保存文件。

因此不要把“多 Agent”理解为“每个 Agent 一个 worktree 后全部同时运行 UE”。先拆分工作类型，再按资源占用决定并行度。

## 调度模型

把每个 Agent 工作声明为一个任务记录，至少包含：

- `task_id`：短且稳定的任务标识；
- `owner`：当前负责人和可联系的会话标识；
- `workspace`：共享工作区、专用工作区或只读快照；
- `baseline`：提交、快照或只读版本标识；共享工作区写入前后都要重新核对；
- `scope`：源码、Blueprint、DataAsset、Config、Build、Cook、Editor、测试等；
- `resources`：需要占用的资源锁；
- `writes`：可能修改的路径和生成物；
- `vcs`：Git/P4 等工作区类型、起始状态和最终收尾责任；
- `validation`：要运行的验证命令；
- `status`：`queued`、`active`、`blocked`、`done` 或 `failed`。

资源锁使用固定名称，避免“我只是编译一下”绕过调度：

| 锁 | 保护范围 | 默认并发 |
|---|---|---:|
| `ue-editor:<project>` | 交互式 Editor、PIE、编辑器自动化；资产写入还需 `asset-save` | 1 |
| `ue-build:<project>` | UBT、UHT、C++ 编译、链接、模块二进制 | 1 |
| `ue-generate:<project>` | GenerateProjectFiles、目标/模块生成、工程文件刷新 | 1 |
| `ue-cook:<project>:<platform>:<output-root>` | Cook、Pak、IoStore、Stage、AutomationTool 及其输出目录 | 1 |
| `ue-ddc:<scope>` | 本地 DDC、Shader 编译、共享缓存清理/迁移 | 1；只有已证明无 miss/编译/写入时才可并行 |
| `workspace-write:<path>` | 共享源码、配置、资产或插件目录写入 | 按路径互斥 |
| `asset-save:<project>:<asset-root>` | UE 资产保存、重定向器修复、批量导入及其依赖闭包 | 1 |
| `test-runtime:<project>:<target>` | Standalone、命令行运行和功能测试；PIE 使用 `ue-editor` | 1；除非端口/设备已隔离 |

资源锁是闭集规则：拿不到锁就排队，不自行猜测“应该没关系”。`<project>` 必须解析为当前 `.uproject` 的规范化绝对路径或稳定项目 ID；`<path>`、`<asset-root>` 和 `<output-root>` 使用规范化绝对路径，Windows 下比较时忽略大小写。路径锁存在祖先/子路径冲突时，以祖先锁覆盖子路径；不同项目或不同已证明隔离的输出根才可并行。

同一 Agent 可以持有多个锁，但必须按表格从上到下的顺序申请，释放顺序反向。PIE 不得同时改用 `test-runtime`；由 Editor 托管的资产保存按 `ue-editor` → `asset-save` 顺序申请。`ue-ddc` 默认独占，不能把“可能命中缓存”当成无写入证据。

锁必须由所有参与 Agent 可见的协调目录或宿主锁服务原子创建，不能只写在某个私有 worktree。锁记录至少包含：`resource_id`、`owner`、`session_id`、`pid`、`command`、`project`、`created_at`、`heartbeat`、`expires_at`、`release_condition`。获取锁前确认冲突锁和任务状态；持有期间更新心跳；完成、失败或取消时记录结果并释放。宿主没有锁服务时，使用 VCS 忽略的共享协调目录，禁止把锁文件提交到项目。

租约过期不等于可以抢占：先核对 PID 是否仍存活、命令行是否指向同一项目、工作区是否仍有写入或 Editor/构建进程，再由主 Agent 记录 stale 判断后解除。未知持有者、无法确认归属或发现生成物正在变化时，只能保持 blocked，不能强制解锁、杀进程或清理缓存。

## 工作区策略

按任务选择以下模式，不要默认创建 worktree：

### A. 共享工作区串行执行（默认）

适用于需要使用真实 UE Editor、修改资产、编译 C++、运行 PIE 或操作 P4 工作区的任务。

- 同一时间只允许一个 Agent 修改同一资源范围；
- UE Editor、编译、Cook 和资产保存必须通过对应锁排队；
- 其他 Agent 可以在不写入的前提下读取、分析和生成补丁；
- 修改前记录基线，完成后只验证限定范围的 diff；
- 禁止一个 Agent 擅自清理另一个 Agent 的 `Intermediate`、`Binaries`、`Saved` 或 DDC。

### B. 专用源码工作区 + 外置 UE 资源

只在项目已验证可以隔离生成目录和 DDC 时使用。worktree 仍不是充分条件，必须同时配置：

- 独立的 `Intermediate`、`Binaries`、`Saved`、插件构建目录和 DDC；
- 独立的 Editor 用户数据、日志目录、端口、设备和临时目录；
- 明确禁止两个实例写入同一个 `.uproject`、`.uplugin`、Config 或资产；
- 每个工作区有独立的编译目标和验证命令；
- 合并前由单一集成 Agent 在干净共享工作区重新生成、编译和验证。

如果无法证明以上隔离成立，退回模式 A。

模式 B 开始前必须逐项记录：`.uproject`/`.uplugin`/Config 是否独占、`Intermediate`、`Binaries`、`Saved`、插件构建目录、DDC、日志和临时目录、Editor 用户数据、端口、设备、Cook 输出根、引擎版本、目标平台/配置以及 VCS 工作区。缺少实际路径、隔离命令或验证证据的项目不能使用模式 B。

### C. 只读快照并行分析

适用于代码阅读、依赖分析、测试设计、补丁草拟和文档工作。快照不得启动会写项目目录的 UE 进程；需要运行 UE 时转入模式 A 或 B 并申请锁。

## 必须串行化的操作

以下操作默认不可并行：

1. 同一项目的 Unreal Editor 启动、PIE、Standalone、编辑器自动化和资产保存；
2. UBT/UHT、C++ 编译、链接、模块加载以及任何会更新 `Binaries`/`Intermediate` 的命令；
3. GenerateProjectFiles、插件/模块发现、目标配置生成；
4. 同一平台的 Cook、Pak、IoStore、Stage、打包和发布；
5. 删除或重建 DDC、Shader 编译缓存、`Intermediate`、`Binaries`、`Saved`；
6. 批量重命名、Fix Up Redirectors、批量导入、迁移资产和修改共享 Config；
7. 对同一源码模块、同一插件或同一资产目录进行写入；
8. 任何会自动保存、生成代码、更新反射头或修改工程文件的工具。

可以并行的典型操作：只读代码分析、只读依赖检查、互不重叠目录的补丁草拟、独立文档编写，以及已证明不会写入共享目录的静态检查。并行不等于跳过锁；只读任务仍需声明其不会启动 UE 或生成文件。

进程判断不能只按进程名：必须结合 PID、命令行中的 `.uproject` 路径、工作目录、用户和启动时间确认是否属于当前任务。`UnrealEditor`、UBT、UHT、ShaderCompileWorker、AutomationTool 或编译器无法归属时，任务保持 blocked；`-WaitMutex` 只解决部分 UBT 互斥等待，不能替代项目级锁。

## 编译和 Editor 规则

- 编译前先检查是否已有 Editor、UBT、UHT 或构建任务；不要杀掉不属于当前 Agent 的进程。
- C++、反射宏、`Build.cs`、`Target.cs` 或模块依赖变更完成后，集成 Agent 默认使用项目实际 UE 引擎根目录下的 `Engine\Build\BatchFiles\Build.bat` 进行可靠验证。不得假设引擎位于项目目录或使用固定引擎路径；先根据 `.uproject` 的引擎关联、项目配置、环境变量或已安装引擎信息定位实际 `Build.bat`，并读取项目实际的 `.uproject` 文件名、项目目录和 Editor Target（通常来自 `<ProjectName>Editor.Target.cs`），再将命令中的占位值替换为真实值：

```powershell
& '<UE_ENGINE_ROOT>\Engine\Build\BatchFiles\Build.bat' <PROJECT_EDITOR_TARGET> Win64 Development `
  -Project="<PROJECT_ROOT>\<PROJECT_UPROJECT>.uproject" `
  -NoUBTMakefiles `
  -WaitMutex
```

- `-DisableUnity` 和 `-NoPCH` 不作为常规编译参数；只有排查单文件 include、声明顺序或预编译头掩盖的问题时，才按实际引擎版本确认参数支持情况，并单独执行隔离编译。`-NoUBTMakefiles` 避免复用过期的 UBT Makefile；`-WaitMutex` 保证构建按 UE 互斥锁排队。不得把 Editor Target、平台或配置硬编码为所有项目通用，必须先读取实际 `.Target.cs` 和 `.uproject`。
- 编译期间禁止另一 Agent 启动 PIE、加载刚编译模块、保存资产或清理生成目录。
- C++ 改动完成后由一个集成 Agent 持有 `ue-build:<project>`，完成 UHT、编译、启动验证和错误归属；其他 Agent 不重复编译同一目标。
- 禁止依赖 Live Coding/Hot Reload 作为多 Agent 集成机制；它可能留下状态不一致的模块和对象。需要验证时优先关闭 Editor，在锁内做全量或目标构建，再重新启动。
- 启动 Editor 前确认目标二进制、插件和生成文件来自当前变更，而不是其他 Agent 的半成品。
- Editor 崩溃或被强制终止后，不要立即删除缓存；先保留日志和状态，确认没有其他持有者，再执行限定范围的恢复。
- 任何清理命令必须写出目标路径和锁，默认不得使用无边界的全项目清理。

## 资产与共享文件规则

- Blueprint、DataAsset、Map、Material、Animation、Niagara 和其他二进制资产按目录或资产清单加写锁；同一资产只允许一个写者。
- 读取资产可以并行，但导入、保存、重定向器修复和编辑器批处理必须独占 `asset-save:<project>:<asset-root>`。
- 不把自动保存、临时备份、日志、`Saved` 和生成的 `Intermediate` 当作可提交成果；根据项目 VCS 规则确认后再处理。
- 不在多个 worktree 中同时修改同一个 `.uproject`、`.uplugin`、`.Target.cs`、`.Build.cs`、Config 文件或插件描述。
- 合并资产改动优先使用 UE 感知的迁移/合并流程；不要把二进制资产当普通文本强行解决冲突。

资产锁的清单同时记录 UE 逻辑路径（例如 `/Game/...`）和文件系统路径，并包含已知依赖闭包：World Partition/External Actors、重定向器、自动生成的 Blueprint/反射文件、批量导入输出和会被 Editor 自动保存的关联资产。无法确认保存范围时按更大的目录加锁，由单一写者完成并在限定清单内验证。

## 验证契约

任务记录中的 `validation` 必须与写入类型匹配，并记录命令、退出码、日志路径和未验证项：

- 源码、`Build.cs`、`Target.cs`、反射宏或模块依赖：由集成 Agent 在 `ue-build` 锁内重新生成并编译，必要时启动当前目标 Editor 验证；
- Blueprint、DataAsset、Map 或其他资产：由单一写者保存，检查资产清单、重定向器和限定范围 diff，再按需要执行 Editor/PIE 验证；
- Cook、Pak、IoStore 或发布产物：锁定具体平台、配置和输出根，保留日志和退出码，集成 Agent 重新检查产物范围；
- 只读分析或补丁草拟：验证基线和文件范围，不把未运行 UE 的静态结论写成运行时通过。

## 排队与故障处置

调度时按以下顺序处理：

1. 先查看任务、进程、锁和工作区状态；
2. 若锁被占用，记录阻塞者和等待资源，不抢锁、不杀进程、不清缓存；
3. 若任务修改范围重叠，拆成先后阶段，或让一个 Agent 生成补丁、另一个 Agent 集成；
4. 若必须让出资源，由锁持有者显式释放并记录结果；
5. 任务失败时保留日志、命令、退出码和工作区状态，标记 `failed`，不要自动回滚或清理其他 Agent 的成果；
6. 怀疑文件锁、Editor 状态或 DDC 损坏时，先停止新增任务并做诊断，再决定是否在维护窗口内修复。

禁止的恢复动作：无授权杀进程、删除共享缓存、`git clean`、全局回滚、覆盖他人改动、强制 checkout、在未知状态下重新生成全部工程文件。

## 推荐的 Agent 分工

- **分析 Agent**：只读检查、依赖图、影响范围和验证方案，不启动 UE。
- **实现 Agent**：在明确路径锁内修改源码或资产，提交补丁/变更清单，不自行占用长时间 Editor。
- **集成 Agent**：唯一负责获取共享 `ue-build`、`ue-editor`、`ue-cook` 锁，生成工程文件、编译、运行 PIE 和汇总日志。
- **验证 Agent**：优先使用只读检查；需要运行 UE 时复用集成 Agent 已释放的锁和明确的验证工作区。

## 最小执行模板

```text
任务: <task_id>
负责人/会话: <owner / session_id>
工作区: shared | isolated | read-only
基线: <提交、快照或只读版本标识>
修改范围: <路径/资产清单>
资源锁: <锁名列表>
VCS: <类型、起始状态和收尾责任>
禁止操作: <不能启动的进程/不能写的目录>
验证: <命令或 Editor 流程>
释放条件: <完成/失败/超时后的明确条件>
```

开始任务前输出或记录该模板。结束任务时记录：实际修改、获得/释放的锁、命令及退出码、生成物、剩余风险和是否需要集成 Agent 复验。

## 完成前检查

- [ ] 已确认 UE 项目根目录、版本、目标平台和 VCS 工作区；
- [ ] 已选择共享工作区、隔离工作区或只读快照，并证明隔离条件；
- [ ] 已记录任务负责人、固定基线、VCS 收尾责任和锁租约；
- [ ] 已声明修改范围和资源锁；
- [ ] 未与其他 Agent 并行运行冲突的 Editor、UBT/UHT、Cook、资产保存或缓存清理；
- [ ] 未杀掉未知归属进程、覆盖他人改动或无边界清理；
- [ ] C++/工程文件改动已由集成 Agent 在锁内重新生成并编译；
- [ ] 资产改动已由单一写者保存，并完成限定范围验证；
- [ ] 任务、锁的获得/释放、命令、退出码和剩余风险已有记录；所有锁和临时资源已释放。
