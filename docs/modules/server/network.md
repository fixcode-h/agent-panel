# server · 出网、版本更新与账号登录

[server 模块](README.md)的子页面：GitHub 出网与代理回退、版本更新、账号与登录。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

## GitHub 出网与代理回退

Node 自带的 `fetch` 不走代理，国内常常连不上 GitHub。`server/net.ts` 把「用哪条路、失败了再试哪条」收在一处，调用方只管传 `timeoutMs` / `signal`。

**出网优先级**（`defaultPlan` → 纯函数 `planFor`）：

1. 设置里的 `proxy`（在「设置 · 网络与代理」），但先过 settings 的「启用代理」开关（`Settings.networkProxyEnabled`，默认 true，加开关之前的老设置按 true 处理，迁移见 `server/settings-migrate.test.ts`）：`server/net.ts` 的 `configuredProxy(settings)` 在开关关闭时返回空串，于是这一条等于没填，直接落到第 2 条环境变量、第 3 条直连。地址没写协议时用 `httpProxy` 补 `http://`，否则 `ProxyAgent` 解析不了；socks 这类不支持的地址照原样交给回退，由请求失败后的回退处理。本机代理自动探测（`localProxies`、`discover`）在第一次尝试失败后照旧执行，不受开关影响。
2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，此时 `NO_PROXY` 照常生效。
3. 直连。

本机地址（`127.0.0.1`、`localhost`、`[::1]`）永远直连，失败也不探测。`NO_PROXY` 只在走环境变量代理时参与判断：命中时直接直连、不进入回退；设置里填了 `proxy` 时以设置为准，不受 `NO_PROXY` 影响。

**失败后的回退**（`netFetchWith` + `attemptOrder`）：第一次尝试失败、且调用方没有中止自己的 signal 时，先探测本机代理，再把没试过的路试完：从直连起步时依次试探测到的本机代理；从配置的代理起步时依次试本机代理、最后再试直连。任何一条成功就返回它的响应，配置的代理也在回退链里，所以「配置了但连不上」不会直接判死。

**本机代理怎么找**（`localProxies`）：

- 系统代理：Windows 读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`（`reg query`，https 优先于 http，分号格式也认）；macOS 跑 `scutil --proxy`；Linux 没有统一读法，交给环境变量。解析函数是纯函数：`windowsProxy`、`parseWindowsProxy`、`parseScutilProxy`。
- 常见端口：顺序和取值只看 `shared/proxy.ts`（`LOCAL_PROXY_PORTS` 与默认端口 `DEFAULT_PROXY_PORT`），文档不重复枚举。按常见程度排依次是（不写具体数字）：Clash / mihomo 的混合端口、v2rayN 的默认入站、老版 v2rayN 的 http 入站、Clash 的 socks 口（历史兼容，探测大概率失败）、Clash Verge Rev 的混合端口、通用的 1080。探测时全部并发跑一遍，真正拿去请求时本地端口最多 `MAX_LOCAL_PROXIES`（3）个、系统代理不算在内，由 `pickLocalProxies` 按顺序挑，所以默认端口必须排在前几个，不会被 Clash 的端口挤掉。默认代理地址只在 `shared/proxy.ts` 定义一次（`rules-check` 会拦住别处再写的字面量）。
- 只认 http 代理：`undici` 的 `ProxyAgent` 只处理 http/https，socks5 地址传进去也用不了（`httpProxy` 会把非 http(s) 的筛掉，`probeProxy` 同样只认 http/https）。默认端口在不同客户端里可能是纯 socks（v2rayN 默认入站就是 `socks`，它的 mixed 入站在 10814）、也可能是 socks+http 的 mixed 同口，就看客户端怎么配的；是纯 socks 时探测会失败，按「没找到代理」回退直连，用户需要在设置里填 http 入站端口。
- 只连上端口不算数：`probeProxy` 向候选发 `CONNECT api.github.com:443`，返回 200 或 407（要认证）才算在运行的代理。所有候选并发探测，单个握手超时 `PROBE_TIMEOUT_MS`（1200ms），另有一条独立的硬超时兜底（连接阶段卡住时也会结束）；系统代理读取本身最多 2 秒，所以没代理时一次探测在几秒内结束。
- 一个都没探测到就保持直连失败，不会强行走代理。
- 缓存：探测到代理缓存 60 秒，没探测到缓存 30 秒（用户刚开代理软件也能较快用上），系统代理读取缓存 60 秒；某条代理请求失败会经 `markProxyBad` → `dropBadProxy` 从缓存里去掉，列表因此变空时把间隔改成「没找到」的 30 秒，代理软件关掉后能重新检测。

**超时与取消**：每次尝试单独计时（`attemptControl`），上一次因为 `timeoutMs` 超时了，下一次会重新计时；`timeoutMs` 只覆盖等响应头，body 由调用方自己管。调用方自己的 `signal` 被中止（主动取消，或用 `AbortSignal.timeout` 给自己的总预算用完）时不再换路径，把原因原样报出去；换路径只由每次尝试自己的 `timeoutMs` 触发。

**失败文案**（`failure` + `netError`）：保留原始原因（连接超时 / 无法解析域名 / 代理拒绝连接等）。最后一条失败的是直连时，附上原来的 `访问不了 GitHub 时，可以在「设置 · 网络与代理」里填写本机代理`；最后一条是代理时，先用 `当前使用代理 xxx，请确认代理能访问 GitHub`，再补一句同样的设置页提示。试过多条路时追加 `尝试过的路径：直连、本机代理 http://…`；探测过、但没有任何本机代理进入尝试列表时追加「没有发现运行中的本机代理。」。报错里的代理地址会去掉账号密码。

**谁在用**（都因此共用同一套回退）：

- `server/update.ts`：检查 releases（`GET /repos/.../releases`，`timeoutMs: 15_000`）和下载 `SHA256SUMS`（同样 15 秒）。
- `server/download.ts`：探测（`probe`）、单连接下载（`stream`）、分片下载（`fetchSpan`）都经过 `DownloadOptions.fetch`（默认就是 `netFetch`，测试可以替换），每处都带 `HEAD_TIMEOUT_MS`（20 秒）的响应头超时，这一段超时会换下一条路。下载中途「太久没收到数据」由 `watch` 计时（分片 45 秒、单连接 90 秒）；`netFetch` 每次换一条路重试前会调用 `init.onAttempt`，下载借此重置空闲计时，所以空闲预算只管单条路径，不会因为整轮回退把「body 卡住」的判定拉长。
- `server/update.ts` 和 `server/download.ts` 不再用 `AbortSignal.timeout`（触发一次后就永久处于中止状态，没法用同一条 signal 重试），改用 `netFetch` 的 `timeoutMs`；其它调用方（例如 `server/comfy-templates.ts`、`server/remote.ts`）仍可用自己的 signal，中止后按上面的规则停止回退。

## 版本更新（GitHub Releases）

`server/update.ts` 的 `updateApi()` 负责设置页的「版本更新」和托盘菜单的「检查更新」，路由挂在 `/app` 下（`/releases`、`/install`、`/install/:id`、`/install/:id/force`、`/install-current`、`/rollback`）。

- 检查结果缓存在数据目录的 `cache/updates/releases.json`：`{ at, list, etag?, limitedUntil? }`。`at` 是上次成功读到列表的时间；自动检查最多每 `CHECK_EVERY`（6 小时）用一次缓存，点「检查更新」带 `refresh=1` 时马上请求。
- 减少请求：缓存里的 `etag` 下次作为 `If-None-Match` 带上，GitHub 回 304 时直接沿用缓存（conditional request 不计入配额），只把 `at` 挪到现在。环境变量 `GITHUB_TOKEN` 存在时带 `Authorization: Bearer`，配额从 60 次/小时提到 5000 次/小时；token 只从环境变量读，不落盘。
- 限流回退：403 / 429 时按响应里的 `retry-after`、其次 `x-ratelimit-reset` 算出 `limitedUntil`（都没有时默认 15 分钟，计算在 `shared/version.ts` 的 `rateLimitUntil`）。有缓存就写进缓存并返回上次的列表，`/releases` 响应里的 `limitedUntil` 让页面显示「显示的是上次检查的结果」的温和提示；没有缓存才报错，文案里带「约 N 分钟后恢复」。冷却期内点「检查更新」也只回缓存，不再请求 GitHub。
- 托盘 `checkAndInstall` 走同一个 `releases(true)`：限流时用缓存列表判断有没有新版本，没有缓存才报失败。
- 在线演示（`web/src/lib/demo-backend.ts`）没有服务端缓存，用浏览器 localStorage 记上次的列表，403 / 429 时同样回退并带 `limitedUntil`。
- 回归：`server/update.test.ts` 覆盖 403 无缓存报错、403 有缓存回退并标出恢复时间、`retry-after` 计算、冷却期不再请求、ETag 304 复用缓存、带 `GITHUB_TOKEN` 时发 `Authorization`。

## 账号与登录

路由把 `server/accounts.ts` 的 `accountsApi()` 挂在 `/accounts` 下（账号列表、`/:cli/login` 的起 / 查 / 取消、粘贴授权码、`/:cli/save`、切账号、登出、凭据检查、API 模型、模型探针与余额）。CLI 定义里 `auth` 各个字段的含义见 [cli-config.md](../../cli-config.md) 的「账号登录 `auth`」，这里只记服务端的做法。

- 全局 API 的三个出网接口都在服务端带密钥请求（页面不直连第三方）：`fetchApiModels`（`POST /accounts/api-models`，列模型）、`probeApiModel`（`POST /accounts/api-probe`，用一个模型真的跑一次最小推理）、`fetchApiBalance`（`POST /accounts/api-balance`，查余额）。探针按协议构造请求：anthropic `/v1/messages`（地址自带 `/v1` 时不重复）、openai-responses `/v1/responses`、openai-chat `/v1/chat/completions`；认证头跟着 `authHeader`（`x-api-key` / `bearer`）和协议走，不写死。提示词只有 `ping`、输出 1 个 token，避免探测花额度。
- 探针的失败一律透传上游原因（`errorDetail` 兼容 `error.message` / `error` / `message` 几种写法，`error` 是对象但没有 `message` 时退到 `type` / `code`，都没有才用状态文本，避免输出 `[object Object]`；截 200 字），200 但正文里没有模型输出也算不通（`looksLikeAnswer` 按协议看 `content` / `output` / `choices`），超时用 `PROBE_TIMEOUT_MS`（60 秒）换成人话，不重试、不把密钥拼进文案。**读 body 阶段的超时单独处理**：上游先回 200、body 迟迟不吐时 `AbortSignal.timeout` 在 `res.text()` 阶段触发，不能 `.catch(() => '')` 吞成空正文，否则会掉进「不是模型回复」分支把超时报成内容不对。列模型和余额原先各自内联的取错误原因写法也收敛到同一个 `errorDetail`。回归：`server/api-config.test.ts` 的「API 探针」几条（成功 / 404 模型不存在 / 401 带上游原因 / 200 非模型回复 / 读 body 阶段超时 / 错误体无 message 时不输出 `[object Object]` / 没填地址、密钥、模型时不发请求）。

- 现在登录着的是谁：`server/accounts.ts` 的 `readLive` 按定义读 `auth.files`、`auth.fields` 和 macOS 钥匙串，一个都读不到就返回空（= 没登录）；`identityOf` 从凭据里认邮箱（认不出的返回空），`fingerprint` 只看凭据内容（sha256(files + keychain) 截 16 位）用于比对和去重。`matchSlot` 把现在的凭据对上已存的账号，`sync` 顺手把变了的凭据写回槽位、更新 active，`saveAs` 存成账号（同邮箱或同指纹的不重复存）。
- 登录的判定：`startLogin` 先 `sync` 一次，现在登录着但还没存下来的账号先 `saveAs` 存好（否则登录新账号会把旧的弄丢），记下 `before = fingerprint(live)` 后跑 `auth.login`。结局由纯函数 `loginOutcome` 定，共五种：`done`、`spawn-error`、`cancelled`、`no-credential`、`unchanged`。
- 默认按「凭据变没变」判：`poll`（600ms）里指纹一变就成功（登录后不自己退出的 CLI 也能判对），进程结束时 `.then` 再比一次。
- `auth.loginAlreadyLoggedIn` 为 `true` 的 CLI（目前只有 Command Code）：退出码 0 且 `readLive` 读得到凭据就算成功，不看指纹。因为这个 CLI 发现已经登录时只打印一句 `Already logged in` 就以退出码 0 结束，凭据文件一个字节都不改，只看指纹会把用户本来好好的登录报成「登录没有完成（退出码 0）」。界面上的「登录」和「登录其他账号」走的是同一个登录流程（`POST /accounts/:cli/login`）：已登录时它同样直接说已登录，结论是「现在仍是这个账号」——`finish(true)` 里 `readLive` 拿到的还是原凭据，`saveAs` 按邮箱或指纹去重，账号列表不会多出一条，也不算失败。
- 真正的失败照旧报失败：退出码非 0，或退出码 0 但读不到凭据（后者是 `登录没有完成：没有找到登录凭据`）。
- 输出：stdout / stderr 经 `onLine` / `onStderr` 进 `take`，`take` 先调 `shared/ansi.ts` 的 `stripAnsi` 再拼进 `job.output`（留最后 4000 字符），并从中找登录网址。存进 `job.output` 之前就清 ANSI，界面 `<pre>`、失败文案的尾部 3 行、「AI 处理」拿到的才是同一份干净文本——CLI 发现标准输出接终端就上色，浏览器不认识 ESC 只会吞掉，留下 `[32m` 这种残码。`stripAnsi` 只清 CSI / OSC / 两字符转义和 `\r`，普通方括号文本（没有 ESC 的 `[32m`、Markdown 链接 `[文字](...)`）原样保留。
