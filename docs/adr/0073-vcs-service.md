# ADR 0073：版本管理服务（判断、运行、签出规则只有一份）

状态：已接受 · 2026-11-23

## 背景

用户 2026-11-23 统一了项目文件名索引之后，要求把同类散在各处的实现也统一（盘点见 `designs/可统一能力盘点-分析.md` 第 1 项）。版本管理是重复最多、真实出事最多的一块：

- 判断目录归哪种版本管理有两份：面板 `server/projects-analyze.ts` 和 UE 插件 `ue/server/detect.ts`，P4 配置文件名一个认 8 个、一个认 4 个，往上找 6 层和 12 层，同一层 svn / p4 先后不同，同一个目录两边可能判断成不同的版本管理。
- 跑 p4 有四套：`p4Runner`（runProcess）、`vcsRun`（execFile）、UE 插件自己的 execFile（不设 PWD，Mac / Linux 上 p4 按 PWD 找 `.p4config` 会连错 client；git 也绕过了 `server/exec/git.ts`）、表格插件。没有统一限流和计数，查不出「谁在反复跑 p4」。
- P4 改文件前后的签出规则有三份：内置钩子 `p4-auto-open`、UE 保存资源、表格保存。2026-11-23「改动不进默认 Changelist」在面板和 UE 各修了一遍，表格那份还只签只读文件。

## 决策

1. 新模块 `server/vcs/`，开放给插件（`shared/plugins/host-modules.json`）：
   - `detect.ts`：`detectVcs(dir)`，唯一的判断。P4 配置文件名取两份的并集加环境变量和 `p4 set` 里的 P4CONFIG（进程里只问一次），往上找 12 层，同一层 git → p4 → svn。不跑 `p4 where`。
   - `run.ts`：`vcsExec('p4' | 'svn', args, cwd)`，唯一起 p4 / svn 进程的地方：设 PWD 和 childEnv、超时、输出上限、每种命令并发最多 8 个、按命令计数（`vcsCallCounts`）。`p4Runner`、`vcsRun` 改成它上面的两种写法，签名不变。git 照旧只走 `server/exec/git.ts`。
   - `p4-plan.ts`：`p4WritePlan(run, files)` 问一次 `fstat` 算出要 edit / add / 已打开 / 落后的二进制资源；`p4Open(run, 'edit' | 'add', files)` 执行并过滤「已打开、被 .p4ignore 忽略、不归这个 client」这类不算错的报错。规则照用户 2026-11-23 定的：在库里没打开的不论只不只读都签出，已在 pending 里的不动，库里没有 / 已删除 / 本地没有的写完后 add，不 sync，只有落后的二进制资源交给调用方去问。
2. 调用方：钩子 `server/hooks/p4-open.ts` 用 `p4WritePlan` / `p4Open`；UE 插件保存资源（`ue/server/p4-checkout.ts`）、表格插件保存和换版本（`tables/server/tables/routes.ts` 的 `p4Edit`、`write.ts` 的 `ensureWritable`）改用同一份；UE 插件里所有 p4 / svn / git 调用经 `ue/server/vcs.ts` 走面板的入口。
3. `server/projects-analyze.ts` 保留 `detectVcs` 的导出，给还没升级的旧版插件用（它一直是开放模块）。

候选方案：

- **只修 UE 那份、不建模块**：没选。规则还会再分叉，下次又要修三遍。
- **签出规则做成插件接口（ctx.vcs）**：暂不做。开放模块已经能让插件直接用同一份代码，接口版本不用为此再升一次；以后需要按项目设置调规则时再收进 SDK。

## 影响

- 新代码判断版本管理、跑 p4 / svn、改 P4 里的文件，只用 `server/vcs/`（AGENTS.md「先找能共用的」一条）。
- UE、表格插件依赖新的开放模块，旧面板装不上新插件（安装时按 `hostModules` 核对，会提示升级面板）。
