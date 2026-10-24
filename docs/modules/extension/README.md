# extension：浏览器扩展（网页生图）

- status: inferred
- source_paths: `extension/`
- entry: `extension/manifest.json`
- analyzed_at: 2026-10-24

## 职责

Chrome MV3 扩展，让本机的 Agent 面板用**已登录的 Gemini / ChatGPT 网页**生成图片：只读取这两个网站的标签页，
不需要 API Key。面板侧的接口在前端设置和「图库 / 设计」相关流程里使用。

- 后台 service worker：`extension/background.js`，接收面板的请求、找或开对应站点标签页、转发指令。
- 页面脚本：`extension/content.js` 在 Gemini / ChatGPT 页面里执行 nav（切到新对话）、submit（写描述并发送）、
  prompt（在已有对话里再要一张图）、check（读新出现的图片）、more（再要一版）。
- 弹出页：`extension/popup.html` + `extension/popup.js`。

## 入口

`extension/manifest.json`：权限只要 `tabs`、`scripting`、`storage`、`alarms`；`host_permissions` 包含本机
`http://127.0.0.1/*` 和两个生图站点。

## 依赖

浏览器（Chromium 系）和本机运行中的面板服务；不参与前端构建。

## 回归验证

- 改动后在浏览器里重新加载解压的扩展，面板里走一遍生图（提交描述、取图）确认能返回图片。
- 网页改版会让选择器失效：`content.js` 每个选择器都准备了几种写法并退到通用判断，改这里要保留兜底。

## 待确认

- 目前没有自动检查覆盖扩展，只能人工验证（待确认）。
