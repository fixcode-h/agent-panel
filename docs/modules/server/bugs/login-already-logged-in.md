# 已登录时点「登录」被判成「没有完成登录（退出码 0）」，且输出里露 ANSI 残码

- 状态：已修复（代码、单测和端到端用例随同一批改动落地，`npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`、`npm run test:e2e:wsl` 均通过）
- 症状：已经登录 Command Code，点「登录」仍报「没有完成登录（退出码 0）」，输出还露 `[32m` 残码
- 入口：`server/accounts.ts` 的 `startLogin`、`take`
- 根因类型：判定逻辑 / 输出清洗
- 模块：`server`（登录流程 `server/accounts.ts`，配套 `shared/accounts.ts`、`shared/ansi.ts`）
- 关键词：Already logged in、退出码 0、登录没有完成、登录判定、ANSI 转义、`[32m`、AI 处理输出

## 现象

用户在设置里本来已经登录 Command Code，点「登录」或「登录其他账号」后，面板弹出红色报错卡片：

```
登录没有完成
Command Code 没有完成登录（退出码 0）
[32m/[39m  [1mAlready logged in[22m，用户 [36mxxx[39m
```

下方的终端框里是同样的两行，只是带着 `[32m`、`[1m`、`[22m`、`[39m` 这类残码；点「AI 处理」时这份脏文本也会进 AI 上下文。

## 复现条件

1. 本机已有有效的 Command Code 凭据（`~/.commandcode/auth.json` 存在且可用）。
2. 设置 · Command Code 面板点「登录」（或「登录其他账号」）。
3. `cmdc login` 发现已登录，输出 `Already logged in`，以退出码 0 退出，**不改写 `auth.json`**。
4. 面板判成失败，报「没有完成登录（退出码 0）」。

## 影响范围

- 所有「登录前已经登录着」的场景，包括用户主动换账号：只要 CLI 选择「保留当前登录、直接以 0 退出」，面板就报失败。
- 任何 CLI 输出带颜色时，登录失败文案、终端框、「AI 处理」的上下文都带 ANSI 残码（浏览器把 ESC 吞掉后只剩 `[32m` 这种可读的脏字符）。

## 根因

1. **登录判定只看凭据指纹**：`server/accounts.ts` 的 `startLogin` 在开始时取 `fingerprint(live)` 存成 `before`，之后只有两条判成功的路——`poll` 里读到快照且 `fingerprint(now) !== before`，或进程结束后同样比一次。`fingerprint`（`createHash` 对 `snap.files` 和 `keychain` 取 sha256）只反映**凭据内容**。已登录时 `cmdc login` 一个字节都不改 `auth.json`（实测：退出码 0，`auth.json` 的 mtime 不变），指纹永远等于 `before`，于是正常退出的成功路径被判成失败。
2. **原始输出直接入档**：`take(text)` 只是把 CLI 输出拼进 `job.output`（截断到 4000 字符），没有剥离 ANSI；这份文本被三处消费：报错文案的尾部 3 行、前端 `<pre>`、以及「AI 处理」传来的 `output`。

## 修法（下次遇到同类问题的规则）

### 判定登录成败：看「退出码 + 凭据读不读得到」，不是只看指纹变化

- 指纹变化继续作为「凭据被改写」的正向信号（有的 CLI 登录后继续往下跑、不自己退出，靠 `poll` 提前判成功）。
- 进程结束时按 `loginOutcome`（纯函数，便于单测）判定：
  - 退出码 0 且当前读得到凭据 → 成功。已登录时 CLI 说 `Already logged in` 就是已登录，算「当前仍是这个账号」，不再是失败。这条路径下 CLI 没动过 `auth.json`（实测退出码 0、`auth.json` 的 mtime 不变），所以面板存的仍是原来那份凭据：用户点「登录其他账号」而 CLI 直接答「已登录」时，结论就是「现在仍是这个账号」，真要换号得先登出再登录。
  - 退出码非 0 → 失败，保留原来带尾部输出的文案。
  - 退出码 0 但读不到凭据 → 仍失败，文案是「登录没有完成：没有找到登录凭据」（和「有凭据但没变」的「{cli} 没有完成登录（退出码 {code}）」分开，由 `loginFailure` 统一产出）。
  - 用户主动停止（`killed === 'stopped'`）仍是「已取消」，不当作成功。
- **「已登录时 login 直接返回 0」是 CLI 自己的行为，写进 CLI 定义**：`CliAuth` 新增 `loginAlreadyLoggedIn` 字段（`shared/accounts.ts`），Command Code 的 `shared/clis/commandcode.json` 置 `true`。代码只读字段，不写 `def.id === 'commandcode'` 这类分支（`scripts/rules-check.mjs` 会拦）。新接 CLI 时按它的实际行为填这个字段，并在 `docs/cli-config.md` 里说明。

### CLI 输出入档前先剥离 ANSI

- 剥离放在**服务端写入 `job.output` 之前**（`take()` 里调 `shared/ansi.ts` 的 `stripAnsi`），不在前端补：同一份文本还要给报错文案和「AI 处理」，只在前端清洗会让另外两处继续脏。
- `stripAnsi` 要覆盖 SGR（`\x1b[…m`，颜色、`1m`/`22m` 加粗、`2m`/`22m` 暗色）、其他 CSI 序列（清行、光标移动等）、OSC，以及回车覆盖（`\r`，进度条常用）。
- 边界：**普通方括号文本必须原样保留**。判断依据是转义序列的结构（ESC/C1 引导 + 参数字节 + 终止字节），不能拿 `[` 加数字直接删，否则 `[1m]` 这类普通文本会被误伤。

## 防复发护栏

- `server/accounts.test.ts`：`loginOutcome` 的各分支（退出码 0 + 有凭据、退出码非 0、退出码 0 + 没凭据、主动停止、字段未开启的 CLI 仍按指纹判定）。
- `shared/ansi.test.ts`：SGR 颜色、`1m`/`22m` 加粗、`2m`/`22m` 暗色、多段混排，以及含普通方括号的非 ANSI 文本（例如 `[1m] 不是转义`、`[info] 已完成`）原样保留。
- `scripts/e2e/14-accounts.mjs`：用 `scripts/fake-cli` 的 `FAKE_AUTH_ALREADY` 走一遍「已登录点登录」，断言 `job.status === 'done'` 且 `job.output` 里没有 `\x1b`。

## 回归验证

```bash
npm run typecheck && npm run lint && npm run test:unit
npx vite build --mode demo   # 或 npm run build
npm run test:e2e:wsl         # 涉及 CLI 参数/输出解析的改动，在 WSL 里跑
```

## 排查路径（下次定位同类问题的顺序）

1. 先看报错文案是由哪段代码拼的：`t('{cli} 没有完成登录（退出码 {code}）')` 只在 `server/accounts.ts` 的 `startLogin` 结尾出现，顺线索看判定条件。
2. 看判定用的「成功信号」是什么：如果只有「凭据指纹变了」，就问一句「CLI 在本来就成功的场景下会不会改文件」。不改文件（已登录、复用已有会话）的场景一律会被误判。
3. 看 CLI 原始输出有没有进界面或提示词：有就确认是否在服务端剥离过 ANSI，别把清洗留给渲染层。

## 落地改动

| 位置                                      | 改了什么                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `shared/accounts.ts`（`CliAuth`）         | 新增 `loginAlreadyLoggedIn` 字段，默认 `false`                               |
| `shared/clis.ts`                          | 两个内置定义（Claude Code、Codex）显式补 `loginAlreadyLoggedIn: false`       |
| `shared/clis/commandcode.json`            | `auth.loginAlreadyLoggedIn: true`                                            |
| `server/accounts.ts`                      | 登录判定抽成纯函数 `loginOutcome`，失败文案抽成 `loginFailure`（`no-credential` 和 `unchanged` 分开）；`take()` 存 `job.output` 前先 `stripAnsi` |
| `shared/ansi.ts`                          | 新增 `stripAnsi`：清 SGR、其他 CSI（含 8 位引导）、OSC 和 `\r`，普通方括号文本不动          |
| `server/accounts.test.ts`                 | `loginOutcome` 各分支（成功 / 退出码非 0 / 无凭据 / 主动停止 / 字段未开启）与 `loginFailure` 的文案分支 |
| `shared/ansi.test.ts`                     | 颜色、加粗、暗色、8 位 CSI、OSC、混排、普通方括号不被改                                     |
| `scripts/fake-cli`                        | `FAKE_AUTH_ALREADY` 模拟「已登录时 `login` 输出 `Already logged in` 并退出 0」；`FAKE_AUTH_NO_CREDENTIALS` 模拟「退出码 0 但没写凭据」 |
| `scripts/e2e/14-accounts.mjs`              | 端到端走两条真实路径：已登录再登录断言 `done` 且输出无 `\x1b`；无凭据断言 `failed` 且文案是「没有找到登录凭据」 |

## 待确认

- 无。写本文档时实现还在同一批改动里进行，之后已按最终代码核对过一遍（`loginOutcome`、`loginFailure`、`take` 里的 `stripAnsi`、`loginAlreadyLoggedIn` 都已落地，`docs/cli-config.md` 的字段表也已同步）。
