---
paths: server/**/*.test.ts, shared/**/*.test.ts, scripts/e2e/**
---

# 测试里起的子进程脚本

## 测试里的子进程脚本要断言输出时，用 exitCode 不用 process.exit

- 规则：用例起的 node 子进程脚本（`nodeScript` 这类）输出很多行、用例又要断言最后几行时，结尾写 `process.exitCode = N`，不写 `process.exit(N)`：stdout 接管道时 Node 是异步写的，`process.exit` 会丢掉还没写出去的输出，断言偶发对不上，CI 的抖动报告会让检查失败。
- 起因：274f1b7 的 `server/background.test.ts`「推回的只是提炼后的日志」用 `process.exit(2)` 收尾，CI 上偶发只读到前 140 来行，「linking step 499」对不上。
