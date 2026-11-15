# extension：浏览器扩展（网页生图、允许嵌入）

- 状态：documented
- 职责：Chrome MV3 扩展：用本机已登录的 Gemini / ChatGPT 网页生图；按站点允许面板的网页页签嵌入不让嵌入的网页
- 源码：`extension/`
- 入口：`extension/manifest.json`
- 关键词：浏览器扩展、Chrome、网页生图、Gemini、ChatGPT、允许嵌入、网页页签
- 更新：2026-11-15

## 职责

Chrome MV3 扩展，让本机的 Agent 面板用**已登录的 Gemini / ChatGPT 网页**生成图片：只读取这两个网站的标签页，
不需要 API Key。面板侧的接口在前端设置和「图库 / 设计」相关流程里使用。

- 后台 service worker：`extension/background.js`，接收面板的请求、找或开对应站点标签页、转发指令。
- 页面脚本：`extension/content.js` 在 Gemini / ChatGPT 页面里执行 nav（切到新对话）、submit（写描述并发送）、
  prompt（在已有对话里再要一张图）、check（读新出现的图片）、more（再要一版）。
- 弹出页：`extension/popup.html` + `extension/popup.js`。
- 允许嵌入（1.6.0 起，面板网页页签用，设计稿「GitHub 项目一键变插件与网页页签」6.4）：弹出页里按站点加，加的时候用
  `chrome.permissions.request` 要这一个站点的权限（`optional_host_permissions`，不要全部网站）；`background.js` 的
  `syncEmbedRules` 按列表写 `declarativeNetRequest` 动态规则，只对「发起方是 127.0.0.1 / localhost 的子框架」去掉
  `X-Frame-Options` 和 `Content-Security-Policy`，直接打开这些网站不受影响。`extension/embed.js` 跑在面板页面上，
  把站点列表写到 `<html data-ap-embed-sites>`，面板据此对这些站点照样开 iframe（`web/src/lib/web-view/tabs.ts` 的 `extensionAllows`）。默认一个站点都没有。

## 入口

`extension/manifest.json`：权限 `tabs`、`scripting`、`storage`、`alarms`、`declarativeNetRequestWithHostAccess`
（没有站点权限时什么都改不了）；`host_permissions` 包含本机 `http://127.0.0.1/*` 和两个生图站点，允许嵌入的站点走
`optional_host_permissions`，用户加一个要一个。

## 依赖

浏览器（Chromium 系）和本机运行中的面板服务；不参与前端构建。

## 回归验证

- 改动后在浏览器里重新加载解压的扩展，面板里走一遍生图（提交描述、取图）确认能返回图片。
- 网页改版会让选择器失效：`content.js` 每个选择器都准备了几种写法并退到通用判断，改这里要保留兜底。

## 待确认

- 目前没有自动检查覆盖扩展，只能人工验证（待确认）。
