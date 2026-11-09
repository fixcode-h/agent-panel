// shared/version.ts 的测试：面板里「本版改了什么」的裁剪、升级要经过的版本
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseChanges, releasesSince, type AppRelease } from './version.ts'

const rel = (version: string, prerelease = false): AppRelease => ({
  tag: `v${version}`,
  version,
  prerelease,
  publishedAt: '',
  notes: '',
  url: '',
  tarUrl: '',
  zipUrl: '',
  size: 0,
})

test('更新内容只留改动各节，去掉标题和下载说明', () => {
  const notes =
    '## Agent 面板 v0.29.1 更新\n\n### 新功能\n\n- **A** — b\n\n### 下载\n\n- Windows — x.zip\n\n完整改动：…\n'
  assert.equal(releaseChanges(notes), '### 新功能\n\n- **A** — b')
  assert.equal(releaseChanges('随便写的说明'), '随便写的说明')
})

test('升级经过的版本：比当前新、不超过目标，正式版不算预览版', () => {
  const list = [rel('0.29.3'), rel('0.29.2-dev', true), rel('0.29.2'), rel('0.29.1'), rel('0.29.0')]
  assert.deepEqual(
    releasesSince(list, '0.29.0', list[0]).map((r) => r.version),
    ['0.29.3', '0.29.2', '0.29.1'],
  )
  assert.deepEqual(
    releasesSince(list, '0.29.1-dev', list[2]).map((r) => r.version),
    ['0.29.2-dev', '0.29.2', '0.29.1'],
  )
  // 从提交数版本号升到新编号：0.29.x 都比 0.28.2782 新
  assert.equal(releasesSince(list, '0.28.2782', list[0]).length, 4)
})
