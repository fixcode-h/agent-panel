# 输入框里打一次标点出来两个

- 状态：已修复（`scripts/ui/composer-ime-newline.mjs`，在 `node scripts/ui-check.mjs 01-composer` 里跑；修复前「打字」「输入法打标点」两条失败）
- 症状：在输入框里用中文输入法打一个标点（如「，」），出来两个；之后按回车可能发不出去。换行（Shift+Enter）后在新的一行开头打标点时必现，换行后直接打的字也会落回上一行末尾
- 入口：`web/src/components/chat/RichInput.tsx`（`serialize`、`paint`、`emit`、`onCompositionEnd`），`web/src/components/chat/tail-break.ts`
- 根因类型：`pre-wrap` 的 contenteditable 末尾最后一个「\n」不成行，浏览器把输入位置规整到「\n」前面
- 模块：`web`
- 关键词：输入框、标点、两个、重复、输入法、IME、composition、组合输入、换行、Shift+Enter、contenteditable、pre-wrap、br

## 现象

用户报「输入框打一次标点出现两个」。

## 根因

输入框的换行是自己插的「\n」文字（Shift+Enter 走 `api.insert('\n')`），输入框是 `white-space: pre-wrap`。块末尾的最后一个「\n」浏览器不画成新的一行，光标虽然停在「\n」后面，Chrome 输入时把位置规整到「\n」前面：

- 直接打字：字落回上一行末尾（`ab\n` 打 x 变成 `abx\n`）。
- 输入法打标点：组合的字先插在「\n」前面，上屏时浏览器又在原来的位置插一遍，一个标点变两个（`ab，，\n`）；而且 compositionend 不来，`composing` 一直是 true，之后的回车都被当成组合中的按键。

## 修复

`tail-break.ts` 的 `syncTailBreak`：内容以「\n」结尾时在最末尾补一个 `<br data-tail>`，让「\n」后面成为真正的一行；不以「\n」结尾时收掉。`serialize` 读回文字时这个 `<br>` 不算。`paint` 后、`emit`（所有输入和程序插入都走它）里、组合结束时各同步一次；组合中不动 DOM，免得打断输入法。

用 CDP 的 `Input.imeSetComposition` 能稳定复现，回归检查覆盖换行后「打字」「输入法打标点」「输入法打字」三种。
