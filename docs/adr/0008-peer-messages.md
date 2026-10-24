# ADR 0008：对话之间的消息统一成「发送消息 / 接收消息」，全部摆在台面上

状态：已接受 · 2026-10-24

## 背景

用户 2026-10-24 提出：子对话收到父对话发来的消息时，界面把它当成用户发的话显示；以后父子对话之间只要直接发消息（交代任务、回答、状态上报、收尾、编译、报错……）都用两种操作显示，好区分调用情况。要求：

- 不再当成用户消息，显示成工具的样子：「发送 / 接收 + 消息类型 + 内容标题」，不同类型不同图标；
- 点整行在下面展开看全文，点中间的标题弹窗看全文；
- 对话之间的所有消息都不隐藏，全部显示出来。

## 事实核对（改动前）

| 路径                                                                | 收件方显示                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `create_conversation` 的第一条要求                                  | 子对话里是用户消息                                       |
| `send_to_conversation`、提问卡片上用户的回答                        | 子对话里是用户消息（`sendToChild` 不带 `panel`）         |
| `finish_child` 的收尾结果、转给子对话的编译结果                     | 子对话里是「合并编译」一行                               |
| `/rule` 广播的新规则                                                | 子对话里是居中的系统消息                                 |
| `reportChild` 状态上报、`message_parent` 汇报、自动交给父对话的提问 | 父对话里 `panel: 'child'`，**界面上被隐藏**              |
| `submit_merge` 收尾请求、编译申请                                   | 父对话里「子对话请求」一行                               |
| `message_peer` 传话、编译占位                                       | 另一个父对话里被隐藏（`panel: 'child'`）                 |
| 发件方的工具行                                                      | 「交给子对话」「回报父对话」「给其他父对话传话」各写各的 |

## 决策

**收件方的消息带 `TaskMessage.peer`（`shared/schema.ts` 的 `PeerFrom`）：发件对话的 id、标题、角色名、关系（parent / child / peer）、类型 `kind`、内容标题 `subject`、是否报错。界面上凡是带 peer 的都画成「接收消息」；发件方发消息的工具（`send_to_conversation`、`send_message`、`message_parent`、`message_peer`）画成「发送消息」。两边共用 `web/src/components/tasks/PeerMessage.tsx` 的 `PeerLine`。**

类型（`PeerKind`）和图标：

| kind       | 标签     | 图标                | 来源                                       |
| ---------- | -------- | ------------------- | ------------------------------------------ |
| `task`     | 交代任务 | ClipboardList       | 新建子对话的第一条、`send_to_conversation` |
| `answer`   | 回答     | MessageSquareReply  | 提问卡片上用户的决定                       |
| `question` | 提问     | CircleHelp          | `message_parent` 提问（「提问」关着时）    |
| `report`   | 汇报     | Activity            | `reportChild` 状态上报、`message_parent`   |
| `wrapup`   | 请求收尾 | GitPullRequestArrow | `submit_merge`                             |
| `merge`    | 收尾结果 | GitMerge            | `finish_child` 合进去 / 没合进去           |
| `build`    | 编译     | Hammer              | 编译申请、编译占位、转给子对话的编译结果   |
| `rule`     | 全局规则 | Scale               | `/rule` 广播                               |
| `chat`     | 传话     | MessagesSquare      | `message_peer`、`send_message`             |

- 一行：类型图标 · 「接收消息 ↙ / 发送消息 ↗」· 类型标签（报错红色，提问和请求收尾强调色）· 内容标题 · 右边「来自 X / 发给 X」。展开处写「已收到 X 发来的消息」和对话标题，子对话可以直接打开。
- `send_message`（节点之间、给子任务传话）同样算发消息：`kind` 取 `chat`、类型标签仍是「传话」，动词是「发送消息」；收件方取工具结果里「…」中的名字，没有就取参数 `to`，正文取参数 `text`。
- 带 peer 的消息留在折叠外面（`fold.ts` 的 `keptOut`），父对话收到的上报不再隐藏。
- 父对话交代的话 `role` 仍是 `user`：交给 CLI 的内容、轮次、回退、交接摘要照旧按它算，只是界面不画成用户气泡；整理成文字带给新会话时写成「父对话「X」」。
- 旧数据没有 peer：`panel: 'child' | 'wrapup'` 且带 `child` 的按 `peerOfMessage` 补成「接收消息」；认不出是谁发的（面板替用户说的话）照旧画成面板的一行。

没选的方案：

- **把父对话的消息改成 `role: 'system'` + 新 panel**：`role === 'user'` 在五十多处被当成「这一轮的要求」（轮次、回退、分叉、标题、交接摘要、存储摘要），改 role 牵动太大；只加标记、改显示就够。
- **只改子对话那一侧**：用户要的是两边对称、所有收发都看得见，父对话里被藏起来的上报正好是看不清调用情况的来源。

## 与现有实现的关系

延续 [0005](./0005-conversation-states.md)「父子之间的操作都显示成工具调用」：上报的状态判定、去重、收尾流程都不变，只是消息多带一份 peer、换一种显示。面板自己的消息（后台命令结果、催合并）不是对话之间的消息，仍是原来的面板行。

`send_message` 只在发件方留一行，不再额外写一条居中说明。原先 `Orchestra.send()`（`shared/engine.ts`）除了把正文记进运行记录（`sendRunMessage` → `TaskRun.messages`），还 push 一条 `role: 'system'`、不带 `peer` / `panel` 的消息，文案是「「{from}」→「{to}」：{text}」；`web/src/components/tasks/Messages.tsx` 的 `inlineEntry()` 只认 `panel: 'ask'`、`peerOfMessage(m)` 和 `m.panel`，这一类落不进去，就走成居中的说明块 `NoteMessage`，整段 markdown 正文铺在对话流中间（用户 2026-10-24 截图反馈）。现在删掉那条 system 消息：发件方由「发送消息」行承载正文（点整行展开、点标题弹窗看全文），收件方照旧在 `TaskRun.messages` 里收到「来自「X」的消息：…」、交给正在跑的节点时标已读。原因是收件方本来就有带 peer 的「接收消息」，发件方再铺一份正文既重复，又打断对话流、把正文摊成一大块。

## 补充：一条消息只交给一个子对话（2026-10-24）

用户截图反馈：用户在父对话里连着定了几条「硬规则」，父对话把每条都用 `send_to_conversation` 逐个转给四五个子对话，父对话里刷出四五行标题一模一样的「发送消息 · 交代任务」。查用户导出的对话：没有同一条发了两遍，是每条都发给了每个子对话；用户随后定下：**用户发的一条消息，父对话挑出关联最紧密的一个子对话交给它处理，不能发给多个子对话去修**（用户定的规则也一样）。

- 面板拒绝：`send_to_conversation` 发现同一段话（去掉首尾空白后完全相同）已经交给了别的子对话，就返回失败，提示选关联最紧密的那一个。判定在 `shared/peer-message.ts` 的 `sentToOther`（按对话里记下的调用查，跨轮次也认得），并行发出、还没记进对话的几次靠 `shared/engine.ts` 的 `handedOff` 补上。再发给同一个子对话（补充、催）照常放行。
- 提示词：父对话的分派说明（`shared/engine.ts`）、`send_to_conversation` 的工具说明、内置统筹角色（`shared/builtin/agents.ts`）都写明「用户的一条消息（连同定下的规则）只交给关联最紧密的那一个子对话」。要所有子对话遵守的规则仍由用户自己用「/rule」发布。
- 旧记录：相邻几次把同一段话交给不同子对话的，界面合成一行（`web/src/lib/tasks.ts` 的 `groupTools`），右边写「发给 N 个：A、B…」，展开列出每个收件人的回执和打开按钮。
- 没选的方案：给 `send_to_conversation` 加 `ids` 一次群发、加一个让父对话自己发布全局规则的工具——用户明确要的是一条消息只交给一个子对话处理。

出口：`server/orchestrator.test.ts`「一条消息只交给一个子对话」、`shared/peer-message.test.ts` 的 `sentToOther`、`web/src/lib/tasks.test.ts` 的 `groupTools`。

## 分期

一次做完。出口：类型检查、lint、单元测试（`shared/peer-message.test.ts`、`web/src/lib/tasks.test.ts`、`fold.test.ts`）、e2e（`04-subagents` 断言回答带 `answer`、收尾请求带 `wrapup`）、界面检查（`02-task` 的「接收消息」行和弹窗）。

2026-10-24 补 `send_message` 时追加的出口：

- 单元测试：`web/src/lib/tasks.test.ts` 断言 `send_message` 判成 `{ kind: 'chat', to: '测试', body: '接口改名了' }`；
- e2e：`05-workflow-edge` 断言节点之间传话后有运行记录（收件方是那个节点），且任务里不再出现「」→「」的居中 system 文本；
- 界面检查：`02-task` 断言「发送消息」行（演示数据在 `web/src/lib/demo-backend.ts`）。

## 开放问题

无。
