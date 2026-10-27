# Spec Delta · test-environment-defaults

## Purpose

让测试结果不依赖运行机器的语言、平台与残留状态：默认语言固定、断言语言无关、e2e 只在 WSL 跑、演示与正式后端字段一致、继承环境先清干净。

## ADDED Requirements

### Requirement: Default English locale

`npm run test:unit`、`npm run test:e2e` 和界面检查入口 MUST 在默认英文语言环境下运行（`LANG`、`LC_ALL` 为 `C.UTF-8` 或等价英文 locale），不得依赖宿主机设置。CI MUST 固定英文环境。显式覆盖语言时 MUST 在日志里打印实际使用的 locale。

#### Scenario: 默认运行使用英文环境

- **WHEN** 在中文 locale 的机器上直接运行 `npm run test:unit`
- **THEN** 运行日志显示实际 locale 为英文，用例全部通过，不出现依赖中文输出的断言失败

#### Scenario: 显式覆盖被记录

- **WHEN** 用户设置 `LANG=zh_CN.UTF-8` 运行测试
- **THEN** 日志打印实际 locale 与覆盖来源，相关用例按中文环境执行

#### Scenario: CI 固定英文

- **WHEN** 检查 CI 测试 job 的配置
- **THEN** 它在英文 locale 下运行测试，与环境变量无关

### Requirement: Language-independent assertions

测试断言 MUST 使用翻译函数（如 `t()`）或语言无关的标识符，MUST NOT 把中文文案写死成期望值。新增硬编码中文断言 MUST 被检查脚本拦截；确有必要的例外 MUST 在断言旁注明原因并被检查脚本识别。

#### Scenario: 中文硬编码断言被拦截

- **WHEN** 新增 `assert.match(output, /预算超限/)` 这样的中文断言
- **THEN** 检查脚本以非零退出，指出文件、行号和改写建议

#### Scenario: 翻译函数断言通过

- **WHEN** 断言写成 `assert.equal(text, t('预算超限'))`
- **THEN** 检查脚本通过，英文环境下用例同样通过

### Requirement: WSL-only e2e

Windows 上的 e2e MUST 通过 WSL Ubuntu-24.04 执行。在非 WSL 环境中尝试运行时 MUST 明确报告「e2e 需要 WSL，当前环境不满足」并以非零退出；MUST NOT 跳过而不报告，也 MUST NOT 假装在 WSL 里跑过。

#### Scenario: Windows 本机直接跑 e2e 时被拒绝

- **WHEN** 在 PowerShell 里直接运行 `npm run test:e2e`
- **THEN** 输出环境不满足的说明和非零退出，提示改用 `npm run test:e2e:wsl`

#### Scenario: WSL 内正常运行

- **WHEN** 在 WSL 里运行 `npm run test:e2e:wsl`（默认发行版为 Ubuntu-24.04）
- **THEN** 分片正常执行并输出汇总

### Requirement: Demo-backend parity

演示后端（浏览器内模拟实现）的响应字段 MUST 与正式后端一致。界面检查的断言 MUST 只依赖两边都提供的稳定字段；后端新增或重命名字段时 MUST 同步演示实现，否则界面检查或演示构建 MUST 失败并指出缺失字段。

#### Scenario: 新增字段两边同步

- **WHEN** 正式后端在任务响应里新增一个字段
- **THEN** 演示后端在同一次提交里提供同名字段，界面检查读取该字段不失败

#### Scenario: 演示实现缺字段时失败

- **WHEN** 正式后端返回 `testBudget`，演示后端没有这个字段而界面检查读取它
- **THEN** 检查失败并输出「演示后端缺少字段 testBudget」，不静默变成 undefined

### Requirement: Clean inherited environment

测试入口 MUST 在启动子进程前清理会改变行为的继承变量（`AGENT_PANEL_*`、`GIT_CONFIG_*` 等），并显式设置本次需要的值。分片 MUST NOT 继承上一轮运行的数据目录、端口或语言设置。

#### Scenario: 继承变量被清理

- **WHEN** 父进程设置了 `AGENT_PANEL_TRAY=1`、`GIT_CONFIG_COUNT=1` 后运行单测
- **THEN** 测试子进程看不到这些变量，或看到的是本入口显式设置的值，日志列出被清理的变量名
