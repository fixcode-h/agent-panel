---
paths: server/auth.ts, server/index.ts, server/ask-mcp.ts, server/orch-mcp.ts
---

# 服务端接口和访问控制

## 给 CLI 调的面板地址要穿过访问令牌，连不上要显示

- 规则：CLI 调的接口（`/api/mcp/*`）没有 Cookie，在 `tokenGuard` 放行、由接口自己核对地址里的随机令牌；桥接（Pi 扩展）连不上面板时报给面板显示，不能只写 stderr。
- 起因：打开「访问令牌」后 `/api/mcp/ask` 一律 401，Pi 一个面板工具都没有，只有模型自己说「没挂上」。
- 防线：`server/auth.test.ts`。
