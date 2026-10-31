# 消息已经发出（气泡标了「已交给 CLI」），输入框里还留着原来的文字；有时点发送要等一会儿才发出去

- 状态：已修复（`npm run typecheck`、`npm run lint`、`npm run build`、WSL 里的 `npm run test:e2e` 通过；界面检查见下）
- 症状：对话右侧已经出现用户那条气泡、下面标着「已交给 CLI，这一轮接着处理」，同一个输入框里仍完整保留着刚发出去的文字；点发送到消息出现之间还要等一段时间
- 入口：`web/src/components/tasks/TaskView.tsx` 的 `send`、`web/src/lib/api.ts` 的 `sendMessage`、`server/tasks.ts` 的 `POST /tasks/:id/messages` / `followUp` / `deliver`
- 根因类型：清空输入框和消息入库都写在 `await` 接口之后；而不带 `interrupt` 的发送接口要等 `followUp → start` 的一串串行前置（settings、项目、git / p4 探测、CLI 拉起）才响应；消息本身早已经 SSE 到界面；`DeliveryHow` 里也没有「待认领」
- 模块：web + server
- 关键词：发送、输入框没清空、发送慢、待认领、已交给 CLI、乐观更新、messageId、POST /tasks/:id/messages

## 现象

用户截图：右边气泡「很多子对话没有拉起」下面标着「已交给 CLI，这一轮接着处理」，左边同一个输入框里还是这段文字。

用户的设计意图：点发送后消息立刻出现、输入框立刻清空，此时状态是「待认领」；CLI 认领后改成「已交给 CLI，这一轮接着处理」。清空不该等任何后端结果。

## 根因

`TaskView.tsx` 的 `send` 原来是：

```ts
const r = await api.sendMessage(task.id, content, files.attachments, false)
apply(r)
followTa.current?.setText('')
files.clear()
```

- 消息既不是乐观插入的（列表要等响应或 SSE），输入框也要等接口返回才清空。
- 接口慢的根因在服务端：`POST /tasks/:id/messages` 走 `followUp`，而 `followUp` 里 `start()` 要先 `getSettings()`、取项目、`gitHead` / `gitNumstat`、`planWrapUp` 里的 `isP4` + `gitHasRemote`、`currentBranch`，最后才拉起 CLI；消息在这之前就 push 进对话并通过 SSE 推给界面。于是界面先看到「已交给 CLI」，输入框却还满着。
- `shared/schema.ts` 的 `DeliveryHow` 只有服务端交付后的结果（wait / steer / notes / held / next / lost / restart），没有「面板已接收、CLI 还没认领」这个状态，界面无从表达「待认领」。

## 修复

- **前端先落地，再提交**（`TaskView.tsx` 的 `send`）：点发送的那一刻清空输入框、清空附件，并把这条消息插进组件自己的 `pendingMsgs`，带 `delivery.how = 'pending'`（文案「待认领」）。`pendingMsgs` **不塞进 `task.messages`**：SSE 推来的整份任务会把它抹掉；画对话时用 `shownTask` 把两者合起来（`toBlocks(shownTask)`）。接口照常在后台 await，`sending` 期间挡下一次发送。
- **一条消息两边同一个 id**：页面 `crypto.randomUUID()` 生成 `messageId` 传给接口（`FollowUpInput.messageId`，`z.uuid()` 校验，避免和已有消息撞 id）。服务端 `followUp` 和 `deliver` 的各条交付路径（`wait` / `next` / `restart`、执行中直接交付、独立分支恢复失败）都沿用它，SSE 和响应按 id 替换成本地那条，不会出现两条；`deliver(stale)` 和 `restartStalled` 原来会重新起一个 id，也一并沿用。
- **服务端记交付事实**：页面上发的消息（带 `messageId`）在 `followUp` 里先记 `delivery.how = 'wait'`（界面「已交给 CLI，这一轮接着处理」）；`start` 抛错、或独立分支没建起来时改成 `lost`。panel / child / peer 这类面板推给对话的消息不记交付方式，不给它们凭空加一行状态。
- **失败不丢字**（`restoreDraft`）：接口报错时撤掉本地那条「待认领」，把原文和附件放回输入框（输入框已经接着写了就接在后面），并 `toast.error` 报错。附件从 `attachmentsNow` 这个渲染期同步的 ref 读当前列表，再和这次发的按路径去重合并——不能读闭包里的旧附件列表，否则会把刚清空的当成还在、附件反而丢了。
- **`ChatComposer` 的 `blocker` 顺序**：`sending` 排到 `!typed` 前面。消息发出去时输入框已经空了，这时再按回车，真正拦住它的是「上一条还在发送」而不是「先写点要求」。
- **面板自己的命令不留假消息**：`/rule` 发布全局规则由服务端 `ruleCommand` 处理，只 push 一条 system 提示、不把用户这条记进对话。页面的本地那条「待认领」按 id 清不掉，会永久挂在对话里。`send` 拿到响应后用 `web/src/lib/tasks.ts` 的 `messageRecorded` 判断：返回的对话里没有这个 id 就撤掉本地那条。
- **启动失败不留下「执行中」**：`start` 一进去就把任务标成 `status='running'`、`working=true` 并写 `runStartedAt`，而失败时执行位已经释放。`followUp` 的 catch 在落盘前把这些字段和速度恢复成启动前的值，再只让这条消息的 `lost` 生效，避免落盘一个没有进程在跑的「执行中」任务。
- **失败时先确认是不是真的没发出去**：请求报错不代表服务端没收到（响应断了而已）。catch 里用 `landedMessage` 先看本地、再问一次服务端；`deliveredToCli` 为真（已记下且不是 `lost`）时只弹错误、不恢复草稿，否则才撤掉本地那条并把原文放回输入框——不然又会出现「消息发出去了、输入框里字还在」。
- **演示版对齐**（`web/src/lib/demo-backend.ts`）：`followUp` 与执行中分支都沿用 `messageId`，带 `messageId` 时同样写 `wait`，字段和正式后端一致。

实测（演示版，把发消息接口人为拖慢 3 秒模拟服务端 `followUp → start` 的串行前置；量的是「点击发送 → 气泡出现 / 输入框清空」）：

|      | 消息出现 | 输入框清空 | 「待认领」 |
| ---- | -------- | ---------- | ---------- |
| 改前 | 3212 ms  | 3184 ms    | 没有       |
| 改后 | 48 ms    | 58 ms      | 有         |

## 回归

- `scripts/ui/02-task.mjs` 的「任务-执行中发消息」：消息出现在对话里时输入框必须是空的。
- `scripts/ui/02-task.mjs` 的「输入框-连按两次回车」：发消息接口拖慢的那几秒里断言输入框已清空、消息上标着「待认领」。
- 失败路径靠 `restoreDraft` 的逻辑保证（原文、附件放回，不覆盖用户已经接着写的内容）；判定用 `web/src/lib/tasks.test.ts` 的两条纯函数用例兜住（`messageRecorded`：`/rule` 返回里没有用户这条；`deliveredToCli`：`lost` 才恢复草稿）。

## 已知限制

- 「待认领 → 已交给 CLI」的切换靠服务端那条消息回来（SSE 或响应）。服务端完全没收到请求时，本地那条会一直停在「待认领」直到接口报错把它撤掉。
