/**
 * 提示点的数量和文案只在 skill-updates.ts 判定：侧栏「Skills」「设置」和设置页的
 * 「Agent」「部署」两项都读这里。重点钉住「没有差异时返回 undefined」——提示点不能一直亮着。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang, t } from '@shared/i18n'
import { deployedUpdateCount, deployedUpdateHint, sharedUpdateCount, sharedUpdateHint } from '@/lib/skill-updates'

setLang('zh')

const bothHint = (n: number) => t('{n} 个自带技能可以更新', { n })
const deployHint = (n: number) => t('{n} 项部署内容有更新，需要重新部署', { n })

test('只数「自带 Skill」那份，部署那份留给定置的点', () => {
  assert.equal(sharedUpdateCount({ shared: [], deployed: [] }), 0)
  assert.equal(sharedUpdateCount({ shared: ['a', 'b'], deployed: ['b', 'c'] }), 2)
  assert.equal(sharedUpdateHint({ shared: [], deployed: [] }), undefined)
  // 只有部署那份要更新时，「Skills」不能亮：这一页的「更新全部」写不到部署目录
  assert.equal(sharedUpdateHint({ shared: [], deployed: ['a', 'a'] }), undefined)
  assert.equal(sharedUpdateHint({ shared: ['a'], deployed: ['a'] }), bothHint(1))
})

test('部署那份有差异才提示，数的是部署那份的条数', () => {
  // 只有「自带 Skill」那一份要更新时，部署页没有差异，不该在部署入口上亮点
  assert.equal(deployedUpdateCount({ shared: ['a'], deployed: [] }), 0)
  assert.equal(deployedUpdateHint({ shared: ['a'], deployed: [] }), undefined)
  assert.equal(deployedUpdateCount({ shared: [], deployed: ['a', 'b'] }), 2)
  assert.equal(deployedUpdateHint({ shared: [], deployed: ['a', 'b'] }), deployHint(2))
  // 同名技能装在不同分类下就是两条（和部署页、server/deploy.ts 的 skillUpdates 同一口径）
  assert.equal(deployedUpdateHint({ shared: [], deployed: ['a', 'a'] }), deployHint(2))
})
