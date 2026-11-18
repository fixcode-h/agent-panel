/**
 * 插件包的校验和（插件框架改进 D1）：和发布时的 sha256 对不上就不装，旧 Release 没有校验文件时不校验。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { checkEntryVersion, installable, MarketEntry, parseMarketIndex, verifySha } from './github.ts'

const zip = Buffer.from('插件包内容')
const sha = createHash('sha256').update(zip).digest('hex')

test('校验和对得上：放行', () => {
  assert.doesNotThrow(() => verifySha(zip, sha, 'ue-1.0.0.zip'))
})

test('没有校验文件（旧 Release）：不校验', () => {
  assert.doesNotThrow(() => verifySha(zip, '', 'ue-1.0.0.zip'))
})

test('校验和对不上：拒绝安装，写明包名和两边的值', () => {
  assert.throws(() => verifySha(Buffer.from('被换过的包'), sha, 'ue-1.0.0.zip'), /ue-1\.0\.0\.zip.*校验和对不上/)
})

// 插件仓库改了版本号但发布没出来（tag 还指着上一版）：下载到旧包时不装，报清楚原因，不悄悄装回旧版
test('市场版本和包里版本对不上：拦下并写明两边版本和下载地址', () => {
  const e = MarketEntry.parse({ id: 'ue', name: 'UE', version: '0.16.5', tag: 'ue-v0.16.4', asset: 'ue-0.16.4.zip' })
  assert.throws(() => checkEntryVersion(e, '0.16.4'), /v0\.16\.5.*v0\.16\.4.*ue-v0\.16\.4\/ue-0\.16\.4\.zip/)
  assert.doesNotThrow(() => checkEntryVersion(e, '0.16.5'))
})

// 插件市场列官方包装配方（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节，Archify）：plugins.json 的 wraps 单独一组，
// 旧面板只读 plugins 不受影响；新面板把配方接在插件后面，标 wrap，检查更新、装依赖、按 id 安装都跳过它
test('plugins.json 的 wraps：接在插件后面、标上游仓库，installable 去掉', () => {
  const list = parseMarketIndex({
    plugins: [{ id: 'ue', name: 'UE', version: '1.0.0', tag: 'ue-v1.0.0', asset: 'ue-1.0.0.zip' }],
    wraps: [
      { repo: 'tt-a1i/archify', id: 'archify', name: 'Archify 架构图', icon: 'layout-template' },
      { repo: 'x/ue', id: 'ue', name: '同 id 的配方' },
    ],
  })
  assert.deepEqual(
    list.map((e) => [e.id, e.wrap ?? '']),
    [
      ['ue', ''],
      ['archify', 'tt-a1i/archify'],
    ],
  )
  assert.deepEqual(
    installable(list).map((e) => e.id),
    ['ue'],
  )
  // 没有 wraps 的旧目录照常读
  assert.equal(parseMarketIndex({ plugins: [] }).length, 0)
  assert.throws(() => parseMarketIndex({ wraps: [] }), /格式不对/)
})
