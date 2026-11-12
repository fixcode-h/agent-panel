/**
 * P4 / SVN 各分支共用文档根（ADR 0052）：按项目文件夹分组、挑沿用的旧文档根、合并其他分支的旧文档
 *（复制 / 跳过 / 另存 .from-<分支>、p4change 和 worklog 搬到 branches/<分支>/、补模块分支）、
 * 新分支读得到老分支的模块文档、别的分支的模块不被当成「已删」、改共用文档根。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：文档组记录写在数据目录里，不能碰真正的 ~/.agent-panel
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'panel-docgroup-data-'))

const { resetDocGroups, resolveDocGroup, setDocGroupRoot } = await import('./group.ts')
const { goneModulesNote, lookupModuleDocs, moduleIndexText } = await import('../module-map.ts')
const { projectDocRoot } = await import('./root.ts')
const { setLang } = await import('../../shared/i18n.ts')

setLang('zh')

const readme = (name: string, src: string, body = '') =>
  `# ${name}：模块\n\n- 状态：documented\n- 职责：${name} 的职责\n- 源码：\`${src}\`\n- 更新：2026-11-01\n\n## 做什么\n${body}\n`

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** <根>/Main/Game 和 <根>/Dev/Game 两个分支，各有一份按旧规则放的 ProjectDoc/docs */
function layout() {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-docgroup-'))
  const main = path.join(root, 'Main', 'Game')
  const dev = path.join(root, 'Dev', 'Game')
  for (const d of [main, dev]) write(path.join(d, 'p4config.txt'), '')
  // 源码：combat 两边都有，ui 只在 Main 上
  write(path.join(main, 'Source', 'Combat', 'a.cpp'), '')
  write(path.join(main, 'Source', 'UI', 'a.cpp'), '')
  write(path.join(dev, 'Source', 'Combat', 'a.cpp'), '')
  const mainDocs = path.join(root, 'Main', 'ProjectDoc', 'docs')
  const devDocs = path.join(root, 'Dev', 'ProjectDoc', 'docs')
  write(path.join(mainDocs, 'modules', 'combat', 'README.md'), readme('combat', 'Source/Combat/', 'Main 的写法'))
  write(path.join(mainDocs, 'modules', 'ui', 'README.md'), readme('ui', 'Source/UI/'))
  write(path.join(mainDocs, 'adr', '0001.md'), '# 同一份 ADR\n')
  write(path.join(devDocs, 'modules', 'combat', 'README.md'), readme('combat', 'Source/Combat/', 'Dev 的写法'))
  write(path.join(devDocs, 'adr', '0001.md'), '# 同一份 ADR\n')
  write(path.join(devDocs, 'worklog', 't1', 'tasks.md'), '- [ ] Dev 上的任务\n')
  write(path.join(devDocs, 'p4change', 't1.p4change.md'), 'CL 123\n')
  return { root, main, dev, mainDocs, devDocs }
}

test('第一次用到：沿用模块最多的旧文档根，其他分支的旧文档合进来，冲突另存成 .from-<分支>', async () => {
  resetDocGroups()
  const { root, dev, main, mainDocs, devDocs } = layout()
  try {
    // 从 Dev 打开：Main 的模块多，沿用 Main 的那份
    const g = await resolveDocGroup(dev, 'p4')
    assert.equal(g.root, mainDocs)
    assert.equal(g.branch, 'Dev')
    assert.equal(g.branchDir, path.join(mainDocs, 'branches', 'Dev'))
    // 沿用的那份原地补上分支
    assert.match(readFileSync(path.join(mainDocs, 'modules', 'combat', 'README.md'), 'utf8'), /- 分支：Main\n- 更新/)
    // 内容不同的另存，带上来源分支；一样的不复制
    const alt = path.join(mainDocs, 'modules', 'combat', 'README.from-Dev.md')
    assert.match(readFileSync(alt, 'utf8'), /Dev 的写法[\s\S]*/)
    assert.match(readFileSync(alt, 'utf8'), /- 分支：Dev/)
    assert.deepEqual(g.conflicts, ['modules/combat/README.from-Dev.md'])
    assert.equal(existsSync(path.join(mainDocs, 'adr', '0001.from-Dev.md')), false)
    // 只属于分支的记录搬到 branches/<分支>/ 下
    assert.equal(existsSync(path.join(mainDocs, 'branches', 'Dev', 'worklog', 't1', 'tasks.md')), true)
    assert.equal(existsSync(path.join(mainDocs, 'branches', 'Dev', 'p4change', 't1.p4change.md')), true)
    assert.equal(existsSync(path.join(mainDocs, 'worklog')), false)
    // 旧目录不删，留一份去向说明
    assert.equal(existsSync(path.join(devDocs, 'modules', 'combat', 'README.md')), true)
    assert.match(readFileSync(path.join(devDocs, 'MOVED.md'), 'utf8'), /已在 .* 合并到/)

    // 再打开一次不重复合并；Main 也加入同一组
    const again = await resolveDocGroup(dev, 'p4')
    assert.deepEqual(again.conflicts, g.conflicts)
    const m = await resolveDocGroup(main, 'p4')
    assert.equal(m.root, mainDocs)
    assert.equal(m.branch, 'Main')
    assert.deepEqual(m.branches.map((b) => b.name).sort(), ['Dev', 'Main'])

    // 「文档」合完删掉 .from- 文件，就不再列
    rmSync(alt)
    assert.deepEqual((await resolveDocGroup(dev, 'p4')).conflicts, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('新分支读得到老分支的模块文档；别的分支写的标出来源，不被当成「已删」', async () => {
  resetDocGroups()
  const { root, dev } = layout()
  try {
    const d = await projectDocRoot(dev, [], 'p4')
    assert.equal(d?.branch, 'Dev')
    assert.equal(d?.outside, true)
    // 「先建文档」：Main 写的 ui 模块在 Dev 上也算已有
    const found = await lookupModuleDocs(dev, [], ['ui', 'combat', 'net'])
    assert.deepEqual(Object.keys(found.found).sort(), ['combat', 'ui'])
    assert.deepEqual(found.missing, ['net'])
    // 协调器的模块索引：标出来源分支和本分支没有源码
    const index = await moduleIndexText(dev, [])
    assert.match(index, /当前分支是「Dev」/)
    assert.match(index, /ui｜.*（来自 Main 分支，本分支没有这些源码）/)
    assert.match(index, /派「文档」，params 写 \{"task": "合并"\}/)
    // ui 的源码只在 Main 上：在 Dev 上不提示清理
    assert.equal(await goneModulesNote(dev, []), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提示词：给出共用文档根、本分支目录和模块文档的分支规则', async () => {
  resetDocGroups()
  const { root, dev, mainDocs } = layout()
  try {
    const { docRootText } = await import('../../shared/doc-root.ts')
    const text = docRootText(await projectDocRoot(dev, [], 'p4'))
    assert.match(text, new RegExp(`文档根是 \`${mainDocs.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\``))
    assert.match(text, /当前分支是「Dev」/)
    assert.match(text, /p4change 台账、worklog）写在 `.*branches[\\/]Dev`/)
    assert.match(text, /「- 分支：」写成「Dev」/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('改共用文档根：现有内容并到新位置，整组都用新位置', async () => {
  resetDocGroups()
  const { root, dev, main } = layout()
  try {
    await resolveDocGroup(dev, 'p4')
    const next = path.join(root, 'Shared', 'docs')
    const g = await setDocGroupRoot(dev, 'p4', next)
    assert.equal(g.root, next)
    assert.equal(g.manual, true)
    assert.equal(existsSync(path.join(next, 'modules', 'ui', 'README.md')), true)
    assert.equal(existsSync(path.join(next, 'branches', 'Dev', 'worklog', 't1', 'tasks.md')), true)
    assert.equal((await resolveDocGroup(main, 'p4')).root, next)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('不同上级下的同名项目文件夹不算同一个工程', async () => {
  resetDocGroups()
  const a = mkdtempSync(path.join(tmpdir(), 'panel-docgroup-a-'))
  const b = mkdtempSync(path.join(tmpdir(), 'panel-docgroup-b-'))
  try {
    const ga = await resolveDocGroup(path.join(a, 'Main', 'Client'), 'p4')
    const gb = await resolveDocGroup(path.join(b, 'Main', 'Client'), 'p4')
    assert.notEqual(ga.key, gb.key)
    assert.notEqual(ga.root, gb.root)
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})
