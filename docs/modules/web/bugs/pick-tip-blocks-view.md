# 抓取元素时提示条挡住要点的位置

- 状态：已修复
- 模块：`web`（`web/src/components/chat/ElementPicker.tsx` 的 `PickOverlay` / `useTipFade`），配套 `scripts/ui/01-composer.mjs`、`scripts/ui/02-task.mjs`
- 关键词：元素抓取、提示条、浮标、挡住视野、遮挡、悬停淡出、pointer-events-none、点击穿透

## 现象

开了开发者模式、进入「抓取界面元素」后，屏幕顶部居中有一条胶囊提示条（「⧉ 中键抓取元素，左键、右键照常可用 Esc 或 快捷键 退出抓取」），跟着鼠标的浮标也在元素框旁边。用户报：抓取的时候鼠标移到提示条上，它挡住视线，希望它自动隐藏；浮标挡在鼠标附近时同理。

## 根因

提示条和浮标只有显示、没有任何「躲开鼠标」的行为。外层 overlay 是 `pointer-events-none`，提示条自己也是 `pointer-events-none`（抓取期间点击要穿透到下面的页面），因此浏览器不会给它发 `pointerenter` / `pointerleave`：**不能靠让提示条吃指针事件来实现悬停隐藏**，那会破坏「抓取期间点击仍能选中下面元素」的既有约定。

## 修复

- 用抓取时本来就在跟踪的 `pointermove` 坐标做命中判定：`useTipFade` 每次指针移动时判断指针是否落在提示条 / 浮标自己的 `getBoundingClientRect()` 内（留 `TIP_HIT_SLACK_PX` 容差），是则加 `opacity-0` 淡出，移开再淡回来。
- 进出各留一点延迟（`TIP_HIDE_DELAY_MS` / `TIP_SHOW_DELAY_MS`），鼠标擦过时不会闪一下。
- 真隐藏而不是挪走或卸载：不产生布局跳动，`inert` 让隐藏期间不会被 Tab 到；整条仍是纯文字、没有可聚焦控件。
- 指针离开窗口（`mouseout` 且**没有** `relatedTarget`）时按「移开」处理，回来时照常写回当前状态。必须判 `relatedTarget`：文档内从一个元素移到另一个元素时 `mouseout` 也会冒泡到 `document`，把它当成「离开窗口」会把刚起的隐藏计时器清掉，指针停着不动时就再也不淡出了（同文件元素框高亮的 `leave` 早就是先判 `relatedTarget` 再处理）。
- 提示条、浮标加了 `data-pick-tip` / `data-pick-label` 供界面检查定位。

## 防线

- `scripts/ui/01-composer.mjs`「元素抓取-提示条淡出」：鼠标移到提示条中心，用 `waitForFunction` 等 `opacity` 真的落到 0.05 以下（不赌定时器），然后在提示条上横移并逐帧采样 opacity（`requestAnimationFrame` 里取最大值），确认它不会弹回来；移开后等它回到 0.95 以上，并确认这期间抓取模式没退出。
- 同文件「元素抓取-提示条淡出后点击穿透」：提示条淡出时中键点它原来占的位置，输入框里仍要多出一张引用卡片——拦的是「实现时顺手给提示条加了 `pointer-events-auto`」这类改法。
- `scripts/ui/02-task.mjs`「元素抓取-投给点按钮的那个输入框」「元素抓取-父对话按钮投父对话」：父对话和右栏子对话两个输入框同时在场，先用 `body` 点击把焦点挪走（不让焦点/最近聚焦恰好猜对），再从某个输入框的按钮进入抓取，断言引用只出现在那个输入框里。等待卡片时作用域必须和断言一致（都收窄到子对话输入框内部）：`[data-task-panel]` 是整个右栏 aside，消息流里的引用卡片和输入框卡片共用 `data-chip` 标记，拿整栏计数当同步点会被旧卡片提前满足。这条用例跑在独立浏览器页面里：它会往两个输入框塞引用卡片、开关设置弹窗，放在主页面会把后面的焦点用例带脏。
