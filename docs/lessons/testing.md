---
paths: scripts/e2e.mjs, scripts/fake-cli/**, scripts/ui-check.mjs, server/**/*.test.ts, server/exec/fixtures/**
---

# 测试

## 测试请求要真的走到被测逻辑

- 规则：e2e 请求要满足全局中间件（Host / Origin、JSON 请求体，否则 415），断言具体的错误信息，不只看状态码。
- 起因：3aa0b22，越权测试一直被 415 拦下，越权校验本身从没测到。
- 防线：人工。

## 测试不依赖系统语言

- 规则：断言中文文案的测试先固定语言；e2e 已固定服务端 `LANG=zh_CN`。
- 起因：3ab9a8d，英文系统上单测失败。
- 防线：CI。

## 改执行流程时假 CLI 跟着改

- 规则：`scripts/fake-cli` 要模拟真实 CLI 的会话方式（RPC 常驻多轮、插话、中断）；执行流程改了，假 CLI 也补上对应行为，否则 e2e 测的是旧流程。
- 起因：7a875fe、74bc98a，RPC 常驻后假 CLI 只能跑一轮。
- 防线：`npm run test:e2e`。

## 在 Claude Code 里开发时别嵌套跑 claude

- 规则：沙盒里直接跑 `claude` 会继承当前会话的环境和会话 id；Claude 的协议用假 CLI 测。Codex 在沙盒里没装。沙盒设了 `ANTHROPIC_BASE_URL`，会混进 API 配置的断言，跑 e2e 用 `env -u ANTHROPIC_BASE_URL npm run test:e2e`。
- 防线：人工。
