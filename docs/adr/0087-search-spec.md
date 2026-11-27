# ADR 0087：搜索规范——不合规范的搜索直接退回

状态：已接受 · 2026-11-27

- 关系：接着 [0081 能力路由](./0081-capability-router.md)（面板的 find）和 [0084 工具网关](./0084-tool-gateway.md)（查找接管）；取代 [0006](./0006-background-commands-supervised.md) 里「全项目 grep -r 转后台」那一条和长命令守卫里的「rg -r 拦一下」。
- 设计稿：项目文件 `designs/规范Agent查找命令-设计稿.md`。

## 背景

用户 2026-11-27 说 Agent 的查找命令太乱。核对 7 份任务导出（707 次查找，共 45 分钟）：同一件事有 9 种写法（`grep -r` 135、`rg` 89、`find -name` 69、`Get-ChildItem -Recurse` 35、`Select-String` 33……），只有 `rg` 读面板经 `RIPGREP_CONFIG_PATH` 给的排除目录和二进制跳过；7 次撞 2 分钟命令超时、一行结果都没有；19 次在磁盘上翻 `luac.exe`。

用户定：给一份全面的搜索规范，对话开始时跟 AGENTS.md 一样交给 Agent；不按规范写的搜索（包括写得不对的 rg）全部直接退回，并告诉它怎么写；要搜的东西在排除目录里时，让 Agent 按规则明确写出要搜哪个排除目录。

## 决策

1. **规范只有一份**（`shared/search-spec/guide.ts`）：写法（按内容 `rg -n`、按名字 `rg --files -g`、看一层 `ls`）、起点（模块目录；项目根要带文件类型；不从盘符根、用户目录、项目上层搜；排除目录里的把那个目录写成起点，不用 `--no-ignore`）、参数（不写 `-r`、「或」写 `A|B`、原文加 `-F`、不吞报错）、按文件类型的写法。文件类型以查找分类的 `FindLang` 为键（`shared/capability-router/find/categories.ts`），加类别不补写法编译不过。
2. **对话开始时交给 Agent**：`server/exec/run-setup.ts` 把规范和角色设定拼在一起进系统提示词（没有系统提示词参数的 CLI 按原来的规矩拼进任务描述），所有经 runner 跑的对话、子对话、工作流节点、子任务都带。引擎提示词里的「搜索（这个项目）」只留这个项目的事实（有没有 find、排除哪些目录），不再教 `find -prune`。
3. **守卫退回**（内置钩子 `search-spec-guard`，精简档起就开）：`shared/search-spec/` 按引号切段、跟着 `cd` 换算起点，逐段问规则注册表（`rules.ts`，一条规则一行）。不是 rg 的搜索按 `to-rg.ts` 换算成等价的 rg 写进退回说明；换算不全的（按修改时间找、`-exec`）只给该怎么做；rg 本身的问题（`-r`、`\|`、`--no-ignore`、吞报错、项目根不带类型）给改好的命令。起点在哪由服务端按真实目录判断（`searchScope`）。在别的命令输出里过滤（`p4 opened | grep x`）不算搜索。
4. **用户指令优先**：退回走 `gateDeny`，说明后面带 `request_override`；设置里能关这个守卫。
5. rg 配置再加 `--max-columns=500 --max-columns-preview`：配表、压缩脚本一行几十 KB，命中一次就撑满输出。

候选方案：

- 面板自动把不合规范的命令改写成 rg 再跑（设计稿 Q1 的 A）：用户选了退回，让 Agent 按规范自己写，写法在它那里收拢。
- 只记录不拦：数据已经足够说明问题。不选。

## 风险

- 单文件 `grep -n` 也退回，多一轮往返；换来的是写法只有一种。
- PowerShell 工具里不一定有 `rg`（Claude Code 的 Bash 里是它自带的）：退回后 Agent 要换 Bash 工具跑，没有 rg 时由本机程序卡提示安装。
- CLI 自带的 Grep / Glob 工具不检查（底下就是 rg，读同一份配置）。
