/**
 * 子任务窗口顶上那块「派给它的要求」：brief 是派发时交给它的原文，结构来自两处——
 * spawn_agents 的 instructions（常带 `## 用户原话`、`## 要做的事` 这类小节）和引擎拼进去的
 * `## 评审交接单（派你的对话整理）` / `## 重试时补充`。这里只测纯逻辑：怎么分块、给谁标重点、
 * 没有原文时降级说什么。旧记录（演示版 localStorage 里的 step）连 brief 字段都没有，不能崩。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang, t } from '@shared/i18n'
import { helperBriefView, type BriefBlock } from '@/lib/helper-brief'

setLang('zh')

const INSTRUCTIONS = `## 用户需求
子任务窗口要展示派发时交给它的要求。

## 要做的事
1. 解析 brief
2. 显示出来

## 验收标准
- 旧记录不崩
`

/** 引擎 briefPart 拼出来的样子：五节，只写有内容的那几节 */
const REVIEW = `## 评审交接单（派你的对话整理）
这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。

### 要达成什么、验收标准
窗口顶部要能一眼看出做什么。

### 已经跑过的检查
npm run typecheck — 通过`

const blocks = (raw: string) => helperBriefView(raw).blocks
const titles = (raw: string) => blocks(raw).map((b: BriefBlock) => b.title)
const block = (raw: string, title: string) => blocks(raw).find((b) => b.title === title)

test('空 brief：降级成一句说明，不给空块（旧记录没有这个字段）', () => {
  for (const raw of [undefined, '', '   \n\t ']) {
    const v = helperBriefView(raw)
    assert.equal(v.empty, true)
    assert.equal(v.blocks.length, 0)
    assert.equal(v.summary, '')
  }
  // 旧记录（演示版从 localStorage 读的 step）连这个字段都没有
  const legacy: { id: string; title: string; brief?: string } = { id: 'h1', title: '旧记录' }
  assert.doesNotThrow(() => helperBriefView(legacy.brief))
  assert.equal(helperBriefView(legacy.brief).empty, true)
})

test('纯文字 brief：没有小节时按段落显示，摘要取第一段', () => {
  const v = helperBriefView('把子任务窗口顶上的初始要求补上。\n\n只读，别改文件。')
  assert.equal(v.empty, false)
  assert.deepEqual(v.paragraphs, ['把子任务窗口顶上的初始要求补上。', '只读，别改文件。'])
  assert.equal(v.blocks.length, 0)
  assert.equal(v.summary, '把子任务窗口顶上的初始要求补上。')
})

test('## 小节：每节一块，顺序不变，正文原样保留', () => {
  assert.deepEqual(titles(INSTRUCTIONS), ['要做的事', '用户需求', '验收标准'])
  assert.equal(block(INSTRUCTIONS, '要做的事')?.body, '1. 解析 brief\n2. 显示出来')
  assert.match(block(INSTRUCTIONS, '要做的事')?.body ?? '', /^1\. 解析 brief/)
})

test('要做的事排在最前，用户原话、验收标准、背景依次跟上', () => {
  const raw = `## 背景
这个窗口以前是空的。

## 验收标准
旧数据不崩。

## 要做的事
加一块要求展示。

## 用户原话
「现在子任务最上面不会展示任何初始信息」`
  assert.deepEqual(titles(raw), ['要做的事', '用户原话', '验收标准', '背景'])
})

test('验收标准、注意点这类小节标成重点', () => {
  const check = (title: string) => block(`${INSTRUCTIONS}\n## ${title}\n内容`, title)?.tone
  for (const title of ['验收标准', '验收', '注意点', '注意事项', '约束', '限制', '必须遵守'])
    assert.equal(check(title), 'key', `${title} 应该是重点`)
  assert.equal(block(`${INSTRUCTIONS}\n## 背景\n来历`, '背景')?.tone, 'plain')
})

test('评审交接单：子节各自成块，验收标准标重点、检查是证据', () => {
  assert.deepEqual(titles(REVIEW), ['要达成什么、验收标准', '已经跑过的检查'])
  assert.equal(block(REVIEW, '要达成什么、验收标准')?.tone, 'key')
  assert.equal(block(REVIEW, '已经跑过的检查')?.tone, 'plain')
})

test('交接单和 instructions 拼在一起：两部分都拆开显示，交接单的引言不重复', () => {
  const raw = `${INSTRUCTIONS.trim()}\n\n${REVIEW}`
  assert.deepEqual(titles(raw), ['要做的事', '用户需求', '验收标准', '要达成什么、验收标准', '已经跑过的检查'])
  // 交接单里那句「这就是评审要用的背景……」是给评审看的提示，不占展示位置
  assert.ok(!JSON.stringify(blocks(raw)).includes('不用再去读模块文档'))
})

test('重试时补充单独一块，标出来是后来又补的要求', () => {
  const raw = `${INSTRUCTIONS.trim()}\n\n## 重试时补充\n上次的改动漏了旧数据。`
  const b = block(raw, t('重试时补充'))
  assert.equal(b?.tone, 'note')
  assert.match(b?.body ?? '', /漏了旧数据/)
})

test('多个重试补充各占一块，不并进上一块', () => {
  const raw = '## 要做的事\n甲\n\n## 重试时补充\n乙\n\n## 重试时补充\n丙'
  assert.deepEqual(titles(raw), ['要做的事', '重试时补充', '重试时补充'])
  assert.deepEqual(
    blocks(raw).map((b: BriefBlock) => b.body),
    ['甲', '乙', '丙'],
  )
})

test('只有重试补充、没有 instructions 时也照常显示', () => {
  const raw = '## 重试时补充\n接着上次没做完的部分'
  assert.equal(helperBriefView(raw).empty, false)
  assert.deepEqual(titles(raw), [t('重试时补充')])
})

test('### 三级标题是小节里的子项，不另起一块', () => {
  const raw = '## 要做的事\n### 解析\n先拆块。\n### 显示\n再画出来。'
  assert.deepEqual(titles(raw), ['要做的事'])
  assert.match(block(raw, '要做的事')?.body ?? '', /### 解析/)
})

test('代码块里的 ## 不是小节（示例里的 Markdown 不能被切开）', () => {
  const raw = '## 例子\n```md\n## 不是小节\n```\n后面还有话。'
  assert.deepEqual(titles(raw), ['例子'])
  assert.match(block(raw, '例子')?.body ?? '', /## 不是小节/)
})

test('交接单里代码块中的 ### 也不是子节（评审常在里面贴差异和 Markdown）', () => {
  const raw = `## 评审交接单（派你的对话整理）
这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。

### 差异里看不到的背景
改动是这样：
\`\`\`md
### 未改的代码
这里是原文
\`\`\`
就这些。`
  // 只有真的那一节，代码块里的 ### 不能变成第二个子节
  assert.deepEqual(titles(raw), ['差异里看不到的背景'])
  const body = block(raw, '差异里看不到的背景')?.body ?? ''
  assert.match(body, /### 未改的代码/)
  assert.match(body, /这里是原文/)
})

test('交接单没有子节时，引擎写给评审的那句提示语不占展示位置', () => {
  const raw = `## 评审交接单（派你的对话整理）
这就是评审要用的背景，不用再去读模块文档、搜项目还原它们。

整段写的交接单：先看这段改动。`
  assert.deepEqual(titles(raw), [t('评审交接单')])
  const body = block(raw, t('评审交接单'))?.body ?? ''
  assert.match(body, /整段写的交接单/)
  assert.ok(!body.includes('不用再去读模块文档'), '提示语应该被剔掉')
})

test('added 只数真正的「重试时补充」块，整体重跑的次数不掺进来', () => {
  // reruns 在整体重跑时也会加（shared/engine.ts 的 1346 / 1732 / 1826），那些不追加 brief，
  // 所以徽标不能拿 reruns 当补充次数，否则数字和正文块数对不上
  assert.equal(helperBriefView(INSTRUCTIONS).added, 0)
  assert.equal(helperBriefView(`${INSTRUCTIONS.trim()}\n\n## 重试时补充\n甲`).added, 1)
  assert.equal(helperBriefView(`${INSTRUCTIONS.trim()}\n\n## 重试时补充\n甲\n\n## 重试时补充\n乙`).added, 2)
  assert.equal(helperBriefView(undefined).added, 0)
  assert.equal(helperBriefView('纯文字，没有小节').added, 0)
})

test('摘要：取要做的事那一节的第一句，没有就用第一段', () => {
  assert.match(helperBriefView(INSTRUCTIONS).summary, /解析 brief/)
  assert.equal(helperBriefView('## 用户原话\n「窗口是空的」').summary, '「窗口是空的」')
  // 只有重试补充时用补充的第一句：总比空着好
  assert.match(helperBriefView('## 重试时补充\n接着上次没做完的部分').summary, /接着上次/)
})

test('标题写在行首时也认（Agent 有时不空行、直接接正文）', () => {
  const raw = '## 要做的事\n先看代码\n## 验收标准\n测试通过'
  assert.deepEqual(titles(raw), ['要做的事', '验收标准'])
  assert.equal(block(raw, '验收标准')?.body, '测试通过')
})

test('第一个小节之前还有一段话时，那段话单独显示在最前面', () => {
  const raw = '这是开场说明。\n\n## 要做的事\n加一块要求展示。'
  const v = helperBriefView(raw)
  assert.equal(v.blocks[0].title, '')
  assert.equal(v.blocks[0].body, '这是开场说明。')
  assert.deepEqual(titles(raw), ['', '要做的事'])
})

test('没有小节的纯文字里出现代码块或行内代码也不出错', () => {
  const raw = '```bash\nnpm run typecheck\n```\n\n再看 `web/src/lib/helper-brief.ts`。'
  const v = helperBriefView(raw)
  assert.equal(v.blocks.length, 0)
  assert.equal(v.empty, false)
  assert.ok((v.paragraphs ?? []).length >= 1)
})
