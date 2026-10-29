# 点开「读取」上传附件的那一行，看图弹窗里是一张坏图

- 状态：已修复（`npm run typecheck`、`npm run lint`、`server/uploads-raw.test.ts` 通过）
- 症状：Agent 读取用户发来的截图（工具行「读取 C:/Users/…/.agent-panel/uploads/<id>/截图-080554.png」），点这一行打开的看图弹窗里只有一个破图标和文件名
- 入口：`server/tasks.ts` 的 `GET /tasks/:id/file/raw`、`GET /tasks/:id/file`；前端 `web/src/components/tasks/FileDialog.tsx`
- 根因类型：接口的放行范围只有对话工作目录，漏了上传目录里的附件
- 模块：`server`（`server/tasks.ts`、`server/uploads.ts`）
- 关键词：读取、看图、坏图、破图、附件、uploads、file/raw、FileDialog、截图

## 现象

用户给的截图：工具行「读取」后面是上传目录里的绝对路径；点开后看图浮层里图片没显示出来，只剩替代文字。

## 根因

1. 工具行打开文件走 `FileDialog`，`target.local` 只有粘贴的本机文件引用才会设；Agent 读的上传附件不带它，图片地址取 `api.taskFileRaw(taskId, path)`，即 `/api/tasks/:id/file/raw`。
2. 这条接口（以及看文本的 `/:id/file`）经 `inTaskDir` → `rawInDir` / `readInDir`，`into(dir, want)` 只允许对话工作目录里面的路径；上传目录在数据目录下，不在工作目录里，返回 400，`<img>` 就成了坏图。
3. 附件本来就能经 `/api/uploads/raw` 读到，这里拒绝并不是在守什么边界。

## 修复

- `server/uploads.ts` 新增 `uploadFileOf(want)`：绝对路径落在上传目录里（按 `uploadDirOf` 判定，`path.resolve` 后比较，越界的 `..` 不算）时返回完整路径。
- `server/tasks.ts` 的 `/:id/file`、`/:id/file/raw` 先看 `uploadFileOf`：是附件就把附件所在目录当根读，其余照旧只认工作目录。

## 防线

- `server/uploads-raw.test.ts` 的「附件目录以外的文件不能借这个接口读」里加了 `uploadFileOf` 的断言：上传目录里的绝对路径（含正斜杠写法）认，别处的、`..` 越界的、相对路径都不认。
