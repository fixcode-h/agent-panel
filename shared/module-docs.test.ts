import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAP_BEGIN, MAP_END, legacyRows, migrateModuleHead, parseModuleDoc, withModuleTable } from './module-docs.ts'

const NEW = `# web：React 前端

- 状态：documented
- 职责：项目、任务等页面
- 源码：\`web/\`
- 入口：\`web/src/main.tsx\`、\`web/src/App.tsx\`
- 关键词：页面、侧栏
- 更新：2026-11-03 · a1b2c3d

## 职责

正文里的 - 状态：stale 不算元数据
`

test('模块文档元数据：新格式的中文字段、旧格式的英文字段都认，正文里的同名字段不算', () => {
  const d = parseModuleDoc('web', NEW)!
  assert.equal(d.title, 'React 前端')
  assert.equal(d.status, 'documented')
  assert.deepEqual(d.sources, ['web/'])
  assert.deepEqual(d.entry, ['web/src/main.tsx', 'web/src/App.tsx'])
  assert.deepEqual(d.keywords, ['页面', '侧栏'])
  const old = parseModuleDoc(
    'shared',
    '# shared：共享\n\n- status: inferred\n- source_paths: `shared/`\n- entry: `shared/schema.ts`\n\n## 职责\n',
  )!
  assert.equal(old.status, 'documented', '旧状态都读成 documented')
  assert.deepEqual(old.sources, ['shared/'])
  assert.equal(parseModuleDoc('x', '- 状态：stale\n# x：y\n- 状态：stale')!.status, 'stale')
  assert.equal(parseModuleDoc('x', '没有标题'), null)
})

test('模块地图：有生成区只换生成区，旧的手写表换成生成区，表格外的手写段落原样保留', () => {
  const docs = [parseModuleDoc('web', NEW)!, parseModuleDoc('app', '# app：动作\n\n- 职责：动作表 | 带竖线\n')!]
  const legacy = `# 模块地图\n\n说明一行\n\n| 模块 | 路径 | 职责 | 入口 | 文档 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| web | \`web/\` | 前端 | \`App.tsx\` | [x](modules/web/README.md) | inferred |\n\n## 依赖方向\n\n手写段落\n`
  const out = withModuleTable(legacy, docs)
  assert.ok(out.includes(MAP_BEGIN) && out.includes(MAP_END))
  assert.ok(out.includes('说明一行') && out.includes('## 依赖方向\n\n手写段落'), '手写段落保留')
  assert.ok(out.indexOf('| app |') < out.indexOf('| web |'), '按模块名排序')
  assert.match(out, /动作表 \\\| 带竖线/, '单元格里的竖线转义')
  assert.doesNotMatch(out, /\| inferred \|/, '旧表换掉了')
  // 再生成一次不变（重复调用不产生改动）
  assert.equal(withModuleTable(out, docs), out)
  // 只改生成区
  const edited = out.replace('手写段落', '改过的手写段落')
  assert.ok(withModuleTable(edited, docs.slice(0, 1)).includes('改过的手写段落'))
  assert.doesNotMatch(withModuleTable(edited, docs.slice(0, 1)), /\| app \|/)
  // 「文档」自己写的地图把标记的说明换了个说法：照样认作生成区
  const paraphrased =
    '# 地图\n\n<!-- 模块表：按元数据维护，不要手改 -->\n\n| 模块 | 源码 |\n| --- | --- |\n| calc | `src/` |\n\n<!-- /模块表 -->\n'
  assert.match(withModuleTable(paraphrased, docs), /\| web \| `web\/` \|/)
  // 没有地图时建一个骨架
  assert.match(withModuleTable('', docs), /^# 模块地图/)
})

test('迁移旧格式的头：英文字段换成中文、职责从旧地图补上，正文不动；已是新格式的原样返回', () => {
  const old =
    '# web：React 前端\n\n- status: inferred\n- source_paths: `web/`\n- entry: `web/src/App.tsx`\n- analyzed_at: 2026-10-25\n\n## 职责\n\n正文\n'
  const rows = legacyRows(
    '| 模块 | 路径 | 职责 | 入口 | 文档 |\n| --- | --- | --- | --- | --- |\n| web | `web/` | React 前端页面 | `App.tsx` | x |\n',
  )
  assert.deepEqual(rows[0], { name: 'web', path: '`web/`', role: 'React 前端页面', entry: '`App.tsx`' })
  const out = migrateModuleHead(old, rows[0].role)
  assert.match(
    out,
    /^# web：React 前端\n\n- 状态：documented\n- 职责：React 前端页面\n- 源码：`web\/`\n- 入口：`web\/src\/App.tsx`\n- 更新：2026-10-25\n\n## 职责\n\n正文\n$/,
  )
  assert.equal(migrateModuleHead(NEW, 'x'), NEW)
})
