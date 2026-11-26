/**
 * 演示里那条「到货提醒」工作流的需求原话对照表：用正式后端同一份 applyNeeds 写进去（shared/run/needs.ts），
 * 留一条没落地，工作流卡片和运行页能看到「还有一条没落地」的样子
 */
import type { Task } from '@shared/schema'
import { applyNeeds } from '@shared/run/needs'

export function demoNeeds(task: Task) {
  const rec = task.runs.at(-1)
  if (!rec || rec.needs.length) return
  const at = rec.startedAt || new Date().toISOString()
  applyNeeds(
    rec,
    '识别现场与方案',
    [{ text: '商品缺货时显示「到货提醒」按钮' }, { text: '用户点击后登记手机号' }, { text: '到货时发短信通知' }],
    at,
  )
  applyNeeds(
    rec,
    '实现',
    [
      { id: 'N1', state: 'done', note: 'ProductDetail.tsx 缺货分支显示按钮' },
      { id: 'N2', state: 'done', note: 'RestockForm.tsx + POST /api/restock，单测 restock.test.ts' },
    ],
    at,
  )
}
