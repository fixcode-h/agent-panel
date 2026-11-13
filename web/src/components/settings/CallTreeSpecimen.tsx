import { Markdown } from '@/components/tasks/Markdown'

/** 设置 → 组件里的调用栈树样例：真的 Markdown 组件画 calltree 代码块，微调立刻跟着变（示例数据不翻译） */
const SAMPLE = [
  '```calltree',
  '% 读代码推出 · 位置已核对 5/5',
  'CartPage.onDelete  web/src/cart/CartPage.tsx:88  — 点删除按钮  {L1+}',
  '  cartStore.removeItem(id)  web/src/cart/store.ts:48  — 删掉这一件，算剩几件  [left=0]  {L2+}',
  '    ! if (left === 0) return  web/src/cart/store.ts:51  — 剩 0 件时直接返回  <left === 0 → 真>  [left=0 => 继续派发 count=0]  {H1}',
  '      | 50   const left = items.size',
  '      |>51   if (left === 0) return',
  "      | 52   emit('cart:change', { count: left })",
  '    --- 断在这里：L2 之后没有 L3',
  "    ~ emit('cart:change', { count })  web/src/cart/store.ts:52  — 该派发却没派发  {L3-}",
  '      => 事件 cart:change',
  '      ? 现象：角标停在 1  web/src/cart/Badge.tsx:15  — 没人通知它更新',
  '    - persist()  web/src/cart/store.ts:60',
  "    - track('remove')  web/src/cart/store.ts:61",
  '```',
].join('\n')

const TEAM = new Set<string>()

export function CallTreeSpecimen() {
  return <Markdown text={SAMPLE} teamNames={TEAM} className="w-full max-w-3xl" />
}
