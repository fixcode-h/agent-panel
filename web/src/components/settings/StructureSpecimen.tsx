import { Markdown } from '@/components/tasks/Markdown'

/**
 * 设置 → 组件里的功能结构样例：真的 Markdown 组件画面板拼的 structure 代码块（shared/bug/views.ts 的格式），
 * 默认打开时序图，微调立刻跟着变（示例数据不翻译）
 */
const PAYLOAD = {
  pick: 'sequence',
  why: '4 个参与者、中间隔着事件派发，看来回比看缩进清楚',
  stack: [
    'CartPage.onDelete  web/src/cart/CartPage.tsx:88  — 点删除按钮',
    '  cartStore.removeItem(id)  web/src/cart/store.ts:48  — 算剩几件  [left=0]',
    '    ! if (left === 0) return  web/src/cart/store.ts:51  — 剩 0 件时直接返回  <left === 0 → 真>',
    "    ~ emit('cart:change')  web/src/cart/store.ts:52  — 该派发却没派发",
    '      ? 现象：角标停在 1  web/src/cart/Badge.tsx:15',
  ].join('\n'),
  diagrams: [
    {
      kind: 'sequence',
      title: '删最后一件时角标为什么不归零',
      source: [
        'sequenceDiagram',
        '  actor 用户',
        '  participant CartPage',
        '  participant Store as cart/store',
        '  participant Badge',
        '  用户->>CartPage: 点删除',
        '  CartPage->>Store: remove(id)',
        '  Store->>Store: left = items.size',
        '  alt left === 0（出错点 store.ts:51）',
        '    Store-->>CartPage: 提前 return',
        '    Note over Store,Badge: cart:change 没派发，角标停在 1',
        '  else left > 0',
        '    Store->>Badge: emit cart:change',
        '  end',
      ].join('\n'),
      nodes: [
        { id: 'CartPage', file: 'web/src/cart/CartPage.tsx', line: 88, ok: true },
        { id: 'Store', file: 'web/src/cart/store.ts', line: 51, ok: true },
        { id: 'Badge', file: 'web/src/cart/Badge.tsx', line: 15, ok: false, why: '第 15 行附近没有 Badge' },
      ],
    },
  ],
}
const SAMPLE = ['```structure', JSON.stringify(PAYLOAD, null, 1), '```'].join('\n')

const TEAM = new Set<string>()

export function StructureSpecimen() {
  return <Markdown text={SAMPLE} teamNames={TEAM} className="w-full max-w-3xl" />
}
