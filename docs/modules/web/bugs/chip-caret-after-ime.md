# 粘贴图片后按退格删不掉，卡片还在但文件名没了

- 状态：已修复（`scripts/ui/composer-ime-chip.mjs`，在 `node scripts/ui-check.mjs 01-composer` 里跑；修复前三条都失败）
- 症状：往输入框粘贴图片后，按退格卡片删不掉；有时卡片外壳还在，上面的文件名不见了。偶发，用中文输入法时容易遇到
- 入口：`web/src/components/chat/RichInput.tsx`（`selectionchange`、`onCompositionEnd`、`onKeyDown`、`rangeNow`），`web/src/components/chat/chip-caret.ts`
- 根因类型：浏览器把光标放进了 `contenteditable="false"` 的卡片内部，代码默认光标只会在卡片外面
- 模块：`web`
- 关键词：输入框、卡片、chip、图片、粘贴、退格、Backspace、输入法、IME、拼音、组合输入、composition、光标、contenteditable

## 现象

用户报「有时候往输入框粘贴图片，然后按了下退格，发现卡片没有去掉，但是卡片上的图片名字没有了，好久了，不是必现的」。

## 根因

在卡片紧后面用输入法打拼音、再把拼音退格清掉时，组合结束后 Chrome 把光标落在卡片内部（卡片文字的末尾）。光标在卡片里时：

- 退格只认「光标紧挨着卡片」，认不出光标就在卡片里，浏览器原生删除也删不动不可编辑的内容，卡片删不掉；接着上屏的字也会丢。
- 再粘贴图片或文字时，`rangeNow` 直接用这个选区，新内容插进了卡片里面。卡片有最大宽度、文件名那一段允许缩到 0，被挤进来的内容占满后文件名就看不见了，看起来就是「外壳还在、名字没了」。

只有用输入法、而且恰好在卡片后面清掉拼音时才会出现，所以偶发。

## 修复

`chip-caret.ts` 的 `caretOutOfChip`：光标或选区端点落进卡片就挪到卡片外（光标挪到卡片紧后面）。在三处调用：`selectionchange`（组合中也挪，光标在卡片里时不可能有正在组合的字）、`compositionend`、插入内容前的 `rangeNow`。退格 / Delete 时光标在卡片里就删这张卡片；这时 `composing` 记录还是 true 的（组合被打断、compositionend 没来）一并作废。

用 CDP 的 `Input.imeSetComposition` 能稳定复现，回归检查覆盖「正常清空拼音」「组合被普通按键打断」「光标进卡片后再粘贴」三种。
