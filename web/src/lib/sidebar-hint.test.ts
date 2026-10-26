/**
 * 侧栏行收起时的提示要同时表达「名字 + 部署差异 + 有新版本」：
 * 演示版里应用更新恒为不显示，界面检查构造不出两个提示都在的场景，靠这里钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rowTip } from '@/lib/sidebar-hint'

const deployHint = '1 项部署内容有更新，需要重新部署'

test('收起时的提示：名字和两条提示都带上，空的不留分隔符', () => {
  assert.equal(rowTip('设置'), '设置')
  assert.equal(rowTip('设置', deployHint), `设置 · ${deployHint}`)
  assert.equal(rowTip('设置', undefined, '有新版本'), '设置 · 有新版本')
  // 两个来源同时存在时谁都不吃：部署差异和「有新版本」都读得出来
  assert.equal(rowTip('设置', deployHint, '有新版本'), `设置 · ${deployHint} · 有新版本`)
})
