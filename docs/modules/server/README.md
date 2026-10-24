# server：本机 API、JSON 存储、项目和任务管理

- status: inferred
- source_paths: `server/`
- entry: `server/index.ts`
- analyzed_at: 2026-10-24

## 职责

- 本机 HTTP API：Hono + `@hono/node-server`，只监听 `127.0.0.1`（因为会启动本机 CLI、读写项目目录），同时提供前端静态文件。
- 数据存储：用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件，读写集中在 `server/store.ts`，任务单独存在 `server/task-store.ts`。
- 项目与任务：项目扫描和分类（配合 `shared/project-scan.ts`）、任务创建、排队、停止、续跑、任务快照（`server/tasks.ts`、`server/task-store.ts`）。
- 进程与内存路由只作用于当前对话的子树：`/tasks/:id/processes`（列表和合计）、`/tasks/:id/processes/:pid/kill`、`/tasks/:id/processes/clean`、`/tasks/:id/processes/suggest`（AI 清理建议）、`/tasks/:id/memory`（内存曲线）都按 `subtreeIdsOf` 算出的「这个对话 + 它的全部后代」过滤（`shared/run-usage.ts` 的 `subtreeTaskIds`）。关闭进程和 AI 建议用同一集合校验 pid，清理只清子树里的登记残留，不会碰到列表外、属于祖先或兄弟对话的进程。合计只算子树的 CLI 进程：`totalMemory` / `MemoryPoint.total` = `cliMemory` / `cli`，面板自身内存走 `serverMemory` / `server`，不计入对话合计。
- CLI 相关：检测本机 CLI、读取模型列表、一键安装 / 更新 / 卸载（`server/detect.ts`、`server/models.ts`、`server/cli-packages.ts`、`server/install.ts`）。
- 面板能力给 Agent 用：进程内 MCP 工具，编排（`server/orch-mcp.ts`）、向用户提问（`server/ask-mcp.ts`）、UI 设计（`server/design-mcp.ts`）。
- 其他：附件和上传、文件系统接口、AI 创建 / 优化的提示词组装（`server/assist.ts`）、项目教训、导出、版本更新。
- 出网请求（`server/net.ts`）：面板访问 GitHub 的统一入口 `netFetch`，按「设置里的代理 → 环境变量 → 直连」出网，直连或配置的代理失败后自动改用本机正在运行的代理重试；版本更新和安装包下载都用它，见下面的「GitHub 出网与代理回退」。
- 项目更新时的字段保留与校验（`server/index.ts` 的 `parseProject`、`PUT /projects/:id`）：请求没带 `initResult` 时保留旧值（和 `lessons`、`initializedAt` 同一套做法），带上的用 `ProjectProposalSchema` 严格校验，不合法直接拒绝；初始化推荐因此随项目持久化，重开设置还能应用。

## 入口

- `server/index.ts`：路由登记和启动；第一行先加载 `server/lang.ts` 定界面语言。
- `server/net.ts`：需要访问 GitHub 的请求的统一入口 `netFetch(url, init)`（`init` 是 `RequestInit` 加可选的 `timeoutMs` 和 `onAttempt`）；`timeoutMs` 只限制等到响应头的时间，之后读 body 不受影响，不传就一直等；`onAttempt` 在每次尝试（含回退到另一条路）前调用，供调用方重置自己的空闲计时。
- `server/exec/`：真实调用 CLI 的部分单独成模块，见 [server-exec](../server-exec/README.md)。

## 依赖

`shared/` 的数据结构和 CLI 定义、`hono`、`zod`、`cross-spawn`（Windows 上调用 npm 安装的 `.cmd`）、`undici`（`ProxyAgent` 和走代理的 `fetch`，只在 `server/net.ts` 用）。

## GitHub 出网与代理回退

Node 自带的 `fetch` 不走代理，国内常常连不上 GitHub。`server/net.ts` 把「用哪条路、失败了再试哪条」收在一处，调用方只管传 `timeoutMs` / `signal`。

**出网优先级**（`defaultPlan` → 纯函数 `planFor`）：

1. 设置里的 `proxy`（设置 · 常规 · 网络代理）。地址没写协议时用 `httpProxy` 补 `http://`，否则 `ProxyAgent` 解析不了；socks 这类不支持的地址照原样交给回退，由请求失败后的回退处理。
2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，此时 `NO_PROXY` 照常生效。
3. 直连。

本机地址（`127.0.0.1`、`localhost`、`[::1]`）永远直连，失败也不探测。`NO_PROXY` 只在走环境变量代理时参与判断：命中时直接直连、不进入回退；设置里填了 `proxy` 时以设置为准，不受 `NO_PROXY` 影响。

**失败后的回退**（`netFetchWith` + `attemptOrder`）：第一次尝试失败、且调用方没有中止自己的 signal 时，先探测本机代理，再把没试过的路试完：从直连起步时依次试探测到的本机代理；从配置的代理起步时依次试本机代理、最后再试直连。任何一条成功就返回它的响应，配置的代理也在回退链里，所以「配置了但连不上」不会直接判死。

**本机代理怎么找**（`localProxies`）：

- 系统代理：Windows 读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`reg query`，https 优先于 http，分号格式也认）；macOS 跑 `scutil --proxy`；Linux 没有统一读法，交给环境变量。解析函数是纯函数：`windowsProxy`、`parseWindowsProxy`、`parseScutilProxy`。
- 常见端口：`127.0.0.1` 的 7890、10809、7891、7897、10808、1080（`LOCAL_PROXY_PORTS`，Clash 的 7890 在前，V2Ray 的 10809 排第二；10808 是 SOCKS，1080 常见于 SOCKS、也有软件拿它做 HTTP，`ProxyAgent` 不支持 SOCKS）。探测时全部并发跑一遍，真正拿去请求时本地端口最多 `MAX_LOCAL_PROXIES`（3）个、系统代理不算在内，由 `pickLocalProxies` 按顺序挑，V2Ray 不会被 Clash 的端口挤掉。
- 只连上端口不算数：`probeProxy` 向候选发 `CONNECT api.github.com:443`，返回 200 或 407（要认证）才算在运行的代理。所有候选并发探测，单个握手超时 `PROBE_TIMEOUT_MS`（1200ms），另有一条独立的硬超时兜底（连接阶段卡住时也会结束）；系统代理读取本身最多 2 秒，所以没代理时一次探测在几秒内结束。
- 一个都没探测到就保持直连失败，不会强行走代理。
- 缓存：探测到代理缓存 60 秒，没探测到缓存 30 秒（用户刚开代理软件也能较快用上），系统代理读取缓存 60 秒；某条代理请求失败会经 `markProxyBad` → `dropBadProxy` 从缓存里去掉，列表因此变空时把间隔改成「没找到」的 30 秒，代理软件关掉后能重新检测。

**超时与取消**：每次尝试单独计时（`attemptControl`），上一次因为 `timeoutMs` 超时了，下一次会重新计时；`timeoutMs` 只覆盖等响应头，body 由调用方自己管。调用方自己的 `signal` 被中止（主动取消，或用 `AbortSignal.timeout` 给自己的总预算用完）时不再换路径，把原因原样报出去；换路径只由每次尝试自己的 `timeoutMs` 触发。

**失败文案**（`failure` + `netError`）：保留原始原因（连接超时 / 无法解析域名 / 代理拒绝连接等）。最后一条失败的是直连时，附上原来的 `访问不了 GitHub 时，可以在「设置 · 常规 · 网络代理」里填写本机代理`；最后一条是代理时，先用 `当前使用代理 xxx，请确认代理能访问 GitHub`，再补一句同样的设置页提示。试过多条路时追加 `尝试过的路径：直连、本机代理 http://…`；探测过、但没有任何本机代理进入尝试列表时追加「没有发现运行中的本机代理。」。报错里的代理地址会去掉账号密码。

**谁在用**（都因此共用同一套回退）：

- `server/update.ts`：检查 releases（`GET /repos/.../releases`，`timeoutMs: 15_000`）和下载 `SHA256SUMS`（同样 15 秒）。
- `server/download.ts`：探测（`probe`）、单连接下载（`stream`）、分片下载（`fetchSpan`）都经过 `DownloadOptions.fetch`（默认就是 `netFetch`，测试可以替换），每处都带 `HEAD_TIMEOUT_MS`（20 秒）的响应头超时，这一段超时会换下一条路。下载中途「太久没收到数据」由 `watch` 计时（分片 45 秒、单连接 90 秒）；`netFetch` 每次换一条路重试前会调用 `init.onAttempt`，下载借此重置空闲计时，所以空闲预算只管单条路径，不会因为整轮回退把「body 卡住」的判定拉长。
- `server/update.ts` 和 `server/download.ts` 不再用 `AbortSignal.timeout`（触发一次后就永久处于中止状态，没法用同一条 signal 重试），改用 `netFetch` 的 `timeoutMs`；其它调用方（例如 `server/comfy-templates.ts`、`server/remote.ts`）仍可用自己的 signal，中止后按上面的规则停止回退。

## 回归验证

- `npm run typecheck`
- `npm run test:unit`（`server/**/*.test.ts`，每个模块基本都有同名测试）
- 动了任务执行、项目、设置等跨界面流程时跑 `npm run test:e2e`（Windows 上在 WSL 里）
- 动了出网 / 代理：`server/net.test.ts` 覆盖系统代理解析（Windows 注册表输出、macOS `scutil --proxy`）、候选列表与 `pickLocalProxies` 的挑选顺序（V2Ray 10809）、`planFor` 的优先级 / 无协议补全 / `NO_PROXY`、缓存失效（`markProxyBad`）、本机地址识别、直连失败换代理、配置代理失败后回退、全部失败时的文案、本机地址不探测、用户取消或总预算用完时停止、超时后重试、代理握手探测（起真实只处理 CONNECT 的本地服务）。`netFetch` 的回退路径通过 `netFetchWith` 注入 `NetDeps`（`plan` / `direct` / `viaProxy` / `discover` / `proxyFailed`）来测，不用真的连代理。`server/download.test.ts` 通过 `DownloadOptions.fetch` 断言探测、单连接下载和每个分片都经过统一入口、都带 20 秒响应头超时，并带 `onAttempt` 供回退时重置空闲计时；`net.test.ts` 另有用例确认每次尝试前会调用它。

## 待确认

- `server/` 下文件较多（API 路由集中在 `server/index.ts`），新增接口前先确认应该加在路由里还是拆成独立模块（待确认）。
