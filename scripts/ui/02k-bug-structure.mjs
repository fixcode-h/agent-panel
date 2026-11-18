/**
 * 界面检查分片：诊断报告的「功能结构」四个页签（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节，效果图 4a–4c）：
 * 报告里写了时序图、类图时调用栈那一节换成「功能结构」，默认打开 Agent 选的页签并写出理由；切到类图、调用栈；
 * 架构页没画、Archify 没装时给说明和「安装 Archify（官方配方）」，点了直接弹包装弹窗。插件市场里 Archify 标「包装」。
 * 演示数据从头生成，不依赖别的分片
 */

import { runShard } from './harness.mjs'
import { childView, openCartTask, taskPageHelpers } from './task-page.mjs'

const SEQ = [
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
].join('\n')

const CLASS = [
  'classDiagram',
  '  class CartStore {',
  '    +items: Map',
  '    +remove(id)',
  '    -emit(event)',
  '  }',
  '  class Badge {',
  '    +count: number',
  '    +onChange()',
  '  }',
  '  CartStore --> Badge : 派发 change',
].join('\n')

await runShard(import.meta.filename, async (api) => {
  const { check, errors } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  await p.evaluate(
    ([k, seq, cls]) => {
      const db = JSON.parse(localStorage.getItem(k))
      const parent = db.tasks.find((x) => x.title.includes('购物车右上角'))
      const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
      Object.assign(kid, { resolved: false, status: 'done', working: false, bug: { kind: 'report' }, requests: [] })
      const at = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const node = (id, file, line, ok = true) => ({ id, file, line, check: { ok, why: ok ? '' : '附近没有' } })
      kid.bug.diagnoses = [
        {
          phase: 'plan',
          version: 1,
          rev: 1,
          at,
          status: 'pending',
          symptom: '购物车角标在删除最后一件商品后仍显示 1',
          rootCause: '`web/src/cart/store.ts:51` 删除最后一件时提前 return，没有通知订阅者',
          confirmed: true,
          level: 'standard',
          files: ['web/src/cart/store.ts'],
          fix: '去掉提前 return，统一在末尾派发 change',
          options: [
            { id: 'A', title: '去掉提前 return', change: '`remove` 删完总是派发 `cart:change`', files: [] },
            { id: 'B', title: '角标自己订阅存储', change: 'badge.ts 直接监听 storage 事件', files: [] },
          ],
          chosen: { id: 'A', why: '修在源头', whyNotOthers: 'B 只是绕过，别的订阅者照样收不到' },
          stack: [
            {
              id: 'S1',
              file: 'web/src/cart/CartPage.tsx',
              line: 88,
              fn: 'CartPage.onDelete',
              note: '点删除',
              role: 'entry',
            },
            { id: 'S2', parent: 'S1', file: 'web/src/cart/store.ts', line: 48, fn: 'removeItem(id)', note: '算剩几件' },
            {
              id: 'S3',
              parent: 'S2',
              file: 'web/src/cart/store.ts',
              line: 51,
              fn: 'if (left === 0) return',
              note: '剩 0 件提前返回',
              role: 'fault',
            },
            {
              id: 'S4',
              parent: 'S2',
              file: 'web/src/cart/store.ts',
              line: 52,
              fn: "emit('cart:change')",
              role: 'missed',
            },
          ],
          views: {
            pick: 'sequence',
            why: '4 个参与者、中间隔着事件派发，看来回比看缩进清楚',
            diagrams: [
              {
                kind: 'sequence',
                title: '删最后一件时角标为什么不归零',
                source: seq,
                nodes: [
                  node('CartPage', 'web/src/cart/CartPage.tsx', 88),
                  node('Store', 'web/src/cart/store.ts', 51),
                  node('Badge', 'web/src/cart/Badge.tsx', 15, false),
                ],
              },
              {
                kind: 'class',
                title: '谁订阅谁',
                source: cls,
                nodes: [node('CartStore', 'web/src/cart/store.ts', 12)],
              },
            ],
          },
          answers: [],
          notes: [],
          overall: '',
          before: [],
        },
      ]
      localStorage.setItem(`task-child:${parent.id}`, kid.id)
      localStorage.removeItem(`task-run:${parent.id}`)
      localStorage.setItem(k, JSON.stringify(db))
    },
    ['agent-panel-demo-v3', SEQ, CLASS],
  )
  await p.reload()
  await backToTask()

  // 等你确认的一版会自己弹出来；没弹（看过了）就点「查看报告」
  const dlg = p.getByRole('dialog')
  const popped = await dlg
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!popped) await childView(p).locator('.proc-list').getByRole('button', { name: '查看报告' }).last().click()
  const sv = dlg.locator('.md-sv')
  await sv.waitFor({ timeout: 10000 }).catch(() => errors.push('功能结构：报告里没有功能结构页签'))
  if (await dlg.getByText('改在调用栈的哪里', { exact: true }).count())
    errors.push('功能结构：写了时序图后还显示「改在调用栈的哪里」')
  // 默认打开 Agent 选的时序图，图画出来了，节点位置列在下面
  if ((await sv.getAttribute('data-sv-on')) !== 'sequence') errors.push('功能结构：默认没有打开时序图')
  await sv
    .locator('[data-sv-panel="sequence"] .md-mermaid-svg svg')
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('功能结构：时序图没画出来'))
  await sv.scrollIntoViewIfNeeded()
  await check(p, '功能结构-时序图', ['功能结构', '它选的：4 个参与者', '节点在代码里', '位置没对上代码'])

  await sv.locator('.sv-tab[data-sv-tab="class"]').click()
  await sv
    .locator('[data-sv-panel="class"] .md-mermaid-svg svg')
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('功能结构：类图没画出来'))
  if (await sv.locator('[data-sv-panel="sequence"]').isVisible()) errors.push('功能结构：切到类图后时序图还看得见')
  await check(p, '功能结构-类图', ['谁订阅谁'])

  // 切回时序图：藏着的时候画好的图，再显示出来要完整（消息、alt 分支都在）
  await sv.locator('.sv-tab[data-sv-tab="sequence"]').click()
  await p.waitForTimeout(1500)
  await check(p, '功能结构-切回时序图', ['提前 return'])

  await sv.locator('.sv-tab[data-sv-tab="stack"]').click()
  await check(p, '功能结构-调用栈', ['剩 0 件提前返回'])

  // 架构页：演示里没装 Archify，给说明和安装入口；点了弹包装弹窗（演示后端读不了 GitHub，弹窗里报错也算打开了）
  await sv.locator('.sv-tab[data-sv-tab="page"]').click()
  await check(p, '功能结构-架构页-没装', ['画成一页能点的架构页', 'Archify 还没装', '安装 Archify（官方配方）'])
  await sv.getByRole('button', { name: '安装 Archify（官方配方）' }).click()
  await p
    .getByRole('dialog', { name: '从 GitHub 包装插件' })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('功能结构：点「安装 Archify」没有弹出包装弹窗'))
  await check(p, '功能结构-安装Archify弹窗')
})
