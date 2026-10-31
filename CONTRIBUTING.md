# 参与开发

感谢你愿意改进 agent-panel。这份文档说明本项目的开发方式、必须跑通的检查，以及提交与 PR 的要求。动手前先读一遍 [AGENTS.md](AGENTS.md)，那里是本项目所有改动都适用的硬规则。

## 先了解项目

- 全部 TypeScript：前端在 `web/`，服务端在 `server/`，两边共用的结构和逻辑在 `shared/`。
- 用户数据是数据目录（默认 `~/.agent-panel`）下的 JSON 文件。
- 想改哪一块，先按 [AGENTS.md 的「文档地图」](AGENTS.md#文档地图)找对应的专题文档；不要凭猜测改代码。
- 第一次接触项目，建议先读 [README.md](README.md)，再由 [AGENTS.md 的「文档地图」](AGENTS.md#文档地图)按用途找专题文档。

## 环境与启动

需要 Node.js 22.12 及以上版本（Node 20 已于 2026-04 停止维护，Vite 8 也要求 22.12+）。

```bash
npm ci          # 按 package-lock.json 装依赖，不要用 npm i 改锁文件
npm run dev     # 前端 :5173 + 后端 :8787
```

服务端默认只监听 `127.0.0.1`。凭据（密码、令牌、API key）只放数据目录或环境变量，**不要**写进代码、测试、fixtures、文档和提交说明。

## 分支规则

- **从 `dev` 分支开发**：先 `git switch dev`（本地没有就 `git switch -c dev origin/dev`），确认 `git status --short --branch` 显示在 `dev` 上再动手。
- **禁止在 `main` 上直接改**：不提交、不推送，包括小改动、文档修改和临时调试。误留在 `main` 时先切回 `dev`，不要在 `main` 上改完再搬。
- 一个 PR 只做一件事：拆开不相关的改动，方便评审和回滚。
- 发现 `main` 上有未提交改动时先确认它属于谁、要不要带走；不要用 `git checkout .`、`git reset --hard` 或覆盖式 stash 清掉别人的改动。

## 本地检查

提交前在本地只跑受影响的部分，全量交给 CI（推到 `dev` 和开 PR 时都会跑全量单测、端到端测试和界面检查）：

```bash
npm run typecheck      # tsc -b（shared / web / server 分层检查，见根目录 tsconfig.json）+ 漏翻检查（scripts/i18n-check.mjs）
npm run lint           # oxlint + Prettier 格式检查 + 规则检查 + 密钥扫描
npm run test:affected  # 只跑受改动影响的单测；动到高风险区或影响面过宽时自动改跑全量
```

- `test:affected` 还会列出受影响的界面检查分片、以及是否必须跑端到端测试，列出来的照跑；没列出的不用主动跑全量。
- 全量命令：`npm run test:unit`（单测）、`npm run test:e2e`（端到端，用 scripts/fake-cli 模拟各个 CLI）、`node scripts/ui-check.mjs`（界面检查）。CI 失败后用 `--failed` 只复测失败的部分。

- **端到端测试在 Windows 上必须进 WSL（Ubuntu 24.04）跑**，不要在 Windows 本机的 PowerShell / cmd 里跑：
  ```bash
  wsl.exe -d Ubuntu-24.04 -- bash -lc "npm run test:e2e"
  ```
- 只改文档和样式时跑前两条即可。
- 格式问题用 `npx prettier --write <文件>` 改掉，不要留给下一个提交。
- 改了界面：`npm run build` 确认正式版能构建；`test:affected` 列出的界面分片用 `npx vite build --mode demo && node scripts/ui-check.mjs <分片>` 跑（需要 Playwright chromium，截图在 `ui-shots/`）。

## 代码约定

- **CLI 的差异写进 CLI 定义**（`shared/clis.ts`、`shared/clis/*.json`），代码按定义里的字段走，不按 CLI 的名字写分支（`scripts/rules-check.mjs` 会拦）。
- **界面文案用 `t('中文原文')`**，同一个提交里把英文写进 `shared/locales/en/`；漏翻 `npm run typecheck` 会失败。发给 Agent 的提示词、注释、演示数据不翻译。
- 注释用中文，写「为什么」，不写「做了什么」。
- 界面参考 Claude Code 的风格，视觉质量很重要；界面细则见 [docs/lessons/ui.md](docs/lessons/ui.md)。
- Agent 执行出的错误一律显示给用户，不要悄悄重试。
- 不要顺手格式化整个仓库：只动自己改的文件，避免无关 diff 淹没评审。

## 不要提交这些

- **密钥和凭据**：密码、令牌、API key 只放本机数据目录（默认 `~/.agent-panel`）或环境变量。示例只用 `sk-xxxx`、`your-api-key` 这类占位符。`npm run lint` 会跑 `scripts/secret-check.mjs` 扫描全仓和暂存区，发现疑似真实 key 会直接失败；确实要保留的行在结尾加 `secret-check-ok` 并写明原因。
- **真实的本地路径和个人数据**：截图、日志、任务记录、数据目录里的 `*.json`。
- **测试和调试留下的临时产物**：`ui-shots/`、`release/`、`dist-demo/`、临时脚本。
- 提交前用 `git status --short` 看清楚要提交的文件，新文件都 add 了，临时输出没混进来。

## 提交说明

提交说明的标题概括这次改动，正文每条改动一行，用前缀分类，写成「标题 — 说明」：

```text
流程图支持拖线新建节点，修复设置弹窗闪动

新功能：拖线新建节点 — 从节点拖线到空白处松手，弹出菜单新建节点并自动连上
修复：设置弹窗打开位置 — 打开时不再先出现在左上角再跳到中间
改进：下拉框样式 — 所有下拉框换成跟随主题的列表
```

- 前缀：`新功能：`、`改进：`、`修复：`、`依赖：`。
- 用户感受不到的改动（开发文档、教训、测试、格式）标题以 `内部：` 开头，不进更新说明。
- 说明写给用户看：讲用户能感受到的变化，不写内部实现细节。

## 测试与踩坑记录

- 修 Bug 或加功能时补上能复现问题的测试；一份改动至少要有覆盖它的单元测试或端到端用例。
- 修完跑 `npm run test:affected`（它判定要跑 e2e 时再跑 `test:e2e`），全量交给 CI。
- **踩过坑或被评审纠正后，在同一个提交里把教训写进 [docs/lessons/](docs/lessons/README.md)**：写成下次能直接照做的通用规则，附上起因的提交号。能写成检查的，加进 `scripts/rules-check.mjs` 或测试里，文档只留一行指针。动手前想好要改哪些文件，先跑 `node scripts/lessons.mjs <文件...>` 看有没有相关教训。

## Pull Request

1. 大的改动（新功能、跨模块重构、改变执行流程）先开 [Issue](https://github.com/fixcode-h/agent-panel/issues/new/choose) 说明目标和方案，得到维护者确认再动手，避免白做。
2. 提 PR 时按仓库的 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)填写：改了哪些文件、跑了什么验证与结果、影响面。
3. **PR 必须通过 CI**（类型检查、代码检查、单元测试、端到端测试、构建、界面检查）才有机会被合并。CI 红了先看日志修，不要关掉检查或加 `--no-verify`。
4. 评审意见按条回复；不打算改的说明理由。
5. 合并由维护者进行，`main` 只在发布时更新。

## 许可与行为准则

- 本项目采用 [Apache License 2.0](LICENSE) 授权。提 PR 即表示你同意自己的贡献按同一许可发布，并确认你有权提交这些代码。
- 参与本项目请遵守 [行为准则](CODE_OF_CONDUCT.md)。
- 发现安全漏洞**不要**开公开 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。
