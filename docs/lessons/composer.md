---
paths: web/src/components/chat/**, web/src/components/tasks/TaskComposer.tsx, web/src/components/tasks/ChatModelPicker.tsx, web/src/lib/fileDrag.ts, scripts/ui/01-composer.mjs
---

# 对话输入框

## 输入框不能被外面重渲染重画或重挂载

- 规则：`RichInput` 整棵重画只在文字真变了时做（上传完成只换 `img`，组合输入期间跳过、结束后补）；卡片操作点击时重新取 `actions()`，别闭包捕获旧 `files`。
- 规则：输入框用 `draftKey` 自管草稿，打字只重渲染输入框；消息列表按 `memo` 比，`slot` 的签名 `slotKey` 要含全部输入；`Intl` 实例复用。
- 起因：用户反馈实时输出时打字卡、输入框失焦；实测 `Intl` 每次新建占 109ms/3s，`slot` 的 memo 从未命中。
- 防线：`scripts/ui-check.mjs`（推送期间输入框不重挂载、不丢焦点；行内图片卡片上传后还能删除）。

## 对话页的 Agent、模型、强度留在输入框左下角

- 规则：对话页的输入框和新建对话时一样：Agent · 模型 · 强度用 `ChatModelPicker` 放在输入框工具条左边；用角色的对话在同位置只读显示 `RoleModelBadge`，不挪到标题栏。
- 起因：dc23450 照设计稿把 Chat 页的「Agent · 模型」移到标题栏右侧、输入框只留强度，项目对话收成右侧的模型按钮；用户 2026-10-29 要求对话页保持新建时的输入框。
- 防线：`scripts/ui/01-composer.mjs` 的 Chat 页用例（标题栏里不能有「对话用的 Agent」）。

## 文件拖进输入框用左键长按，右键留给菜单

- 规则：文件拖进输入框用左键长按（`fileDrag.ts` 的 `longPressed`，约 300ms），右键留给菜单；拖完压掉补发的 click。
- 起因：拖引用原为右键按住拖动，用户要求改成长按。
- 防线：`scripts/ui/02c-element-pick.mjs` 的「任务-长按拖入引用」。

## 等你确认、等你操作这类提醒紧贴输入框上方悬浮，不排进停靠区

- 规则：这个对话自己要用户点头或处理的提醒（运行命令 / 改文件 / 调用工具 / 节点确认的请求卡、等你操作、流程没走完）放进 `FloatAbove`（`web/src/components/chat/FloatAbove.tsx`）：零高度的锚点放在输入框那一块的最前面，卡片从它往上叠，不把输入框往下顶；离输入框越近越要紧。盖住上面的计划、子对话那几行没关系，**不要把锚点挪到消息区底部**（浮到对话文本里去）。卡片要有不透明的底和 `shadow-pop`（深色主题的 `--ask-bg` 是半透明的，下面垫 `bg-card`）。
- 规则：子对话的请求不在父对话里弹出来：留在子对话栏那一行（`ChildRequestBar`），不进悬浮层。换掉输入框的（AI 提问 `QuestionPanel`、已收尾 / 导入只读的那一行）和常驻的信息条（独立分支条）也不浮；没有输入框可靠的地方（设置弹窗、侧栏按钮下面的 `ScopeRequests`）照旧排在原地。
- 起因：用户 2026-11-10 要求「警告弹窗都改成悬浮在输入框的上方，不再固定挤占位置」。3d753ee 为了不挡计划那几行把悬浮层锚到了消息区底部，还把子对话等你确认的条一起浮进父对话，用户当天纠正：就贴着输入框，挡住计划没事；子对话的弹窗不要在父对话弹。
- 防线：`scripts/ui/02d-workflow.mjs`（改文件审批卡在 `[data-float-above]` 里、底边贴着输入框那一块）。

## 输入框里的光标可能被浏览器放进卡片里，插入和删除前都要先挪出来

- 规则：`RichInput` 的卡片是 `contenteditable="false"`，但输入法组合结束、选区异常时 Chrome 仍会把光标放进卡片内部。处理光标的代码不能假设光标只在卡片外：插入前、选区变化和组合结束时用 `chip-caret.ts` 的 `caretOutOfChip` 挪出来，删除时用 `chipAround` 认出光标所在的卡片。
- 起因：用户反馈粘贴图片后退格删不掉、卡片上的文件名没了（在卡片后打拼音再清掉，光标落进卡片，之后的粘贴插进卡片里面）。
- 防线：`scripts/ui/composer-ime-chip.mjs`（01-composer 分片里用 CDP 模拟输入法）。

## 输入框末尾的「\n」后面要有占位的 <br>，不然打的字落回上一行

- 规则：`RichInput` 是 `pre-wrap` 的 contenteditable，换行是「\n」文字。块末尾最后一个「\n」浏览器不成行，光标停在它后面时 Chrome 会把输入位置规整到「\n」前面。改动 DOM 的地方（重画、插入、输入）都要经过 `tail-break.ts` 的 `syncTailBreak` 补上或收掉末尾的 `<br data-tail>`；读回文字时它不算，组合输入中不动它。
- 起因：用户报输入框打一次标点出来两个（换行后用输入法打标点，组合的字插在「\n」前、上屏又插一遍）。
- 防线：`scripts/ui/composer-ime-newline.mjs`（01-composer 分片里用 CDP 模拟输入法）。
