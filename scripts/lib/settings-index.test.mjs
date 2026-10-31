import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSettingsIndex, extractSettingsIndex } from './settings-index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('设置页索引：按 cur.id 判定页，组件里的行跟着使用处归页、沿用使用处的小节，顺序和页面一致', () => {
  const page = `
    function Body() {
      return (
        <div>
          {cur.id === 'general' && (
            <>
              <Group title={t('执行')}>
                <Row title={t('超时')} desc={t('分钟，填 0 不限制')} hint={t('超时后停止')}><Input /></Row>
                <Shell />
                <Row title={t('尾巴')}><Input /></Row>
              </Group>
            </>
          )}
          {cur.id === 'network' && <Net />}
          {cur.cli && <Cli />}
          <Row title={t('不在任何页里')} />
        </div>
      )
    }`
  const parts = `
    export function Shell() {
      return <Row title={t('命令行')} desc={ok ? t('甲') : <span>乙 {x}</span>}>x</Row>
    }
    export function Net() {
      return <Row title="Proxy" desc={t('代理地址')} />
    }
    export function Cli() {
      return (
        <Group title="Skills">
          <Row title={o.label} />
          <Row title={t('权限')} />
          <Net />
        </Group>
      )
    }`
  const index = extractSettingsIndex({ 'Page.tsx': page, 'parts.tsx': parts })
  assert.deepEqual(index, [
    { section: 'general', title: '执行', isGroup: true },
    { section: 'general', title: '超时', group: '执行', desc: '分钟，填 0 不限制', hint: '超时后停止' },
    { section: 'general', title: '命令行', group: '执行', desc: '甲 乙' },
    { section: 'general', title: '尾巴', group: '执行' },
    { section: 'network', title: 'Proxy', desc: '代理地址' },
    { section: '@cli', title: 'Skills', isGroup: true },
    // 动态标题（o.label）抽不到，跳过
    { section: '@cli', title: '权限', group: 'Skills' },
    { section: '@cli', title: 'Proxy', group: 'Skills', desc: '代理地址' },
  ])
})

test('设置页索引：真实源码里的几项落在对的页', () => {
  const index = buildSettingsIndex(root)
  const find = (title) => index.find((e) => e.title === title && !e.isGroup)
  assert.equal(find('单步超时')?.section, 'general')
  assert.equal(find('单步超时')?.group, '运行')
  // ShellSetting 是单独的组件，用在「常规」的「运行」小节里
  assert.equal(find('命令行 Shell')?.section, 'general')
  assert.equal(find('命令行 Shell')?.group, '运行')
  // Markdown 样式每组都有「字号」：按小节分开去重，不能只剩第一组的
  assert.ok(index.filter((e) => e.section === 'markdown' && e.title === '字号').length > 3)
  assert.equal(find('代理地址')?.section, 'network')
  assert.equal(find('额外参数')?.section, '@cli')
  assert.ok(index.length > 80, `只抽到 ${index.length} 项，抽取规则可能和页面写法对不上了`)
})
