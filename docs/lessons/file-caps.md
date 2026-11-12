---
paths: scripts/file-caps.json, scripts/lib/file-caps.mjs, scripts/file-caps.mjs
---

# 文件行数上限

## 碰到行数上限就按功能拆文件，不压注释、不合并行凑数

- 规则：改一个文件时超过 `scripts/file-caps.json` 里的上限（或快贴着上限），把一块职责完整的代码（一组辅助函数、一个工具的参数定义、一段独立的判定）挪进按功能命名的新文件（放在所属模块的子目录里，`server/`、`shared/`、`web/src/lib/` 顶层不再加文件），原文件只留调用；不删注释、不把两行注释并成一行、不为了行数改写代码格式。新功能的逻辑一开始就写进自己的文件，在大文件里只加一两行调用。只把文件拆小、函数还是那么长不算拆完：函数也有上限（见 `docs/lessons/structure.md`）。
- 起因：用户 2026-11-03 纠正——实施 ADR 0048 时为了让 `server/orch-mcp.ts` 回到 1350 行，把两段写「为什么」的注释压成了一行；改成把参数定义拆进 `server/docs-first-tool.ts`、把查子对话的辅助函数从 `shared/engine.ts` 拆进 `shared/child-lookup.ts`。
- 防线：`scripts/rules-check.mjs` 第 15 条（只许变小）、第 21 条（函数长度、顶层目录）；AGENTS.md 硬规则一行。
