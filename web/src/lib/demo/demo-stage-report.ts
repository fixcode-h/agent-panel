import type { StageReportVersion } from '@shared/flow/stage-report'

/**
 * 演示里「方案」节点交的两版阶段报告（submit_report）：第 1 版你把 Q2 改成了「先不补」，Agent 按你的选择重出了第 2 版，
 * 正在等确认。审阅弹窗的分区、勾选决策、版本下拉、对比上一版都有东西看
 */
const options = {
  q1: [
    { id: 'A', label: '角标订阅购物车 store 的 count', note: '改 2 个文件，和结算栏用同一份数据' },
    { id: 'B', label: '加入商品后手动触发角标刷新', note: '改动最小，但以后新增入口还会漏' },
    { id: 'C', label: '角标每 5 秒轮询一次数量', note: '实现简单，多一次请求，刷新有延迟' },
  ],
  q2: [
    { id: 'A', label: '这次一起补单测', note: '多半小时，防止以后再回归' },
    { id: 'B', label: '先不补，单独排期', note: '这次改动更快合入' },
  ],
  m1: [
    { id: 'A', label: '沿用 useCart() 的现有写法', note: '' },
    { id: 'B', label: '新写一个 useCartCount()', note: '' },
  ],
  m2: [
    { id: 'A', label: '放进 components/cart/ 目录', note: '' },
    { id: 'B', label: '放在页面目录下', note: '' },
  ],
}

const decisions = (q2pick: string) => [
  {
    id: 'Q1',
    title: '角标怎么拿到最新数量',
    question: '角标组件现在自己缓存数量（`CartBadge.tsx:12`），加入商品后不会刷新，这就是 Bug 的原因。',
    options: options.q1,
    pick: 'A',
    why: '根因是有两份数量，只有改成订阅同一份才能根治；B 和 C 都是绕过去。',
    self: false,
  },
  {
    id: 'Q2',
    title: '这次要不要补单测',
    question: '购物车 store 现在没有测试，这次的改动会动到它的广播逻辑。',
    options: options.q2,
    pick: q2pick,
    why: q2pick === 'A' ? '广播逻辑以后还会被别的组件订阅，没有测试很容易再出同样的问题。' : '按你的选择：这次先不补。',
    self: false,
  },
  {
    id: 'M1',
    title: '读数量的写法',
    question: '',
    options: options.m1,
    pick: 'A',
    why: '项目里已有 9 处这么用，照着写。',
    self: true,
  },
  {
    id: 'M2',
    title: '组件放哪',
    question: '',
    options: options.m2,
    pick: 'A',
    why: '和购物车的其他组件放一起。',
    self: true,
  },
]

const details = (test: boolean) => `### 改动
1. \`CartBadge.tsx\` 去掉自己的 \`useState\`，改成 \`const { count } = useCart()\`。
2. 购物车 store 的 \`add\` / \`remove\` 之后统一 \`emit('change')\`，角标和结算栏同时刷新。
${test ? '3. 补一条单测：连续加入两件商品后角标显示 2。\n' : ''}
### 风险
- 结算栏也订阅了 \`change\`，改完要一起看一眼刷新次数。${test ? '' : '\n- 这次不补单测，回归靠手动检查加入、删除两条路径。'}`

export const DEMO_STAGE_REPORTS: StageReportVersion[] = [
  {
    report: {
      summary: '角标不刷新是因为角标组件自己缓存了一份数量。推荐改成订阅购物车 store，同时补一条单测。',
      decisions: decisions('A'),
      details: details(true),
      next: '',
    },
    at: '2026-11-15T09:00:00.000Z',
    picks: { Q2: 'B' },
    result: 'changed',
  },
  {
    report: {
      summary: '角标不刷新是因为角标组件自己缓存了一份数量。改成订阅购物车 store；按你的选择，这次先不补单测。',
      decisions: decisions('B'),
      details: details(false),
      next: '',
    },
    at: '2026-11-15T09:20:00.000Z',
  },
]
