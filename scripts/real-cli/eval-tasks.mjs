/**
 * 真实 API 评测集的固定任务（扩展 5，跑法见 eval.mjs）。
 *
 * 每个任务在一份全新的样例仓库上跑：仓库内容固定（下面的 SAMPLE），任务的提示词固定，
 * 跑完用 check 按仓库里的结果判断做没做对（只看文件和测试，不看模型的回复文字）。
 * 改这里的任务或样例仓库会让前后两次的数字没法比：要改就整组重跑「改之前」那一次。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** 样例仓库：一个没有依赖的小 Node 项目，测试用 node --test，几秒跑完 */
export const SAMPLE = {
  'package.json': JSON.stringify({ name: 'eval-sample', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'README.md':
    '# eval-sample\n\n评测用的小项目：src 下是几个工具函数，test 下是对应的测试，`node --test` 跑全部测试。\n',
  'src/math.js': `/** 两个数相加 */
export function sum(a, b) {
  return a + b
}

/** 平均数：空数组返回 0 */
export function mean(xs) {
  if (!xs.length) return 0
  return xs.reduce((n, x) => n + x, 0) / xs.length
}
`,
  'src/slug.js': `/** 标题转成 URL 里用的 slug：小写，空格换成 -，去掉其他符号 */
export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, '')
    .replace(/\\s+/g, '-')
}
`,
  'test/math.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'
import { mean, sum } from '../src/math.js'

test('sum', () => assert.equal(sum(1, 2), 3))
test('mean', () => {
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(mean([]), 0)
})
`,
  'test/slug.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slug.js'

test('slugify', () => assert.equal(slugify('Hello World'), 'hello-world'))
test('slugify 保留数字', () => assert.equal(slugify('Release 2 Notes'), 'release-2-notes'))
`,
}

/** 在 dir 建样例仓库并提交一次；files 是这个任务要换掉或加上的文件（比如埋一个 Bug） */
export function makeSample(dir, files = {}) {
  for (const [file, text] of Object.entries({ ...SAMPLE, ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'eval@example.com')
  git('config', 'user.name', 'eval')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

/** 跑一段 node 代码检查样例仓库里的函数，返回 true / 出错说明 */
function probe(dir, code) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, stdio: 'pipe', timeout: 30_000 })
    return true
  } catch (e) {
    return String(e.stderr || e.message)
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ')
  }
}

const testsPass = (dir) => {
  try {
    execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'pipe', timeout: 60_000 })
    return true
  } catch (e) {
    return `node --test 没过：${String(e.stdout || '')
      .split('\n')
      .filter((l) => /^not ok/.test(l))
      .join('; ')}`
  }
}

const gitStatus = (dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()

/** 几项检查都过才算做对；没过的写出第一条原因 */
const all = (...xs) => xs.find((x) => x !== true) ?? true

/**
 * 固定任务。prompt 原样发给项目里的新对话（角色是项目工作流的统筹）；
 * answer 是它提问时评测替用户回答的话（没写就答「按你推荐的做」）；check 跑完后在项目目录里判断结果
 */
export const EVAL_TASKS = [
  {
    id: 'edit-fn',
    title: '改一个函数',
    prompt:
      '把 src/math.js 里的 sum 改成能接受任意多个参数（sum(1, 2, 3) 返回 6，sum() 返回 0），原来两个参数的用法不变，补上测试。',
    check: (dir) =>
      all(
        testsPass(dir),
        probe(
          dir,
          "import { sum } from './src/math.js'; if (sum(1,2,3) !== 6 || sum() !== 0 || sum(1,2) !== 3) process.exit(1)",
        ),
      ),
  },
  {
    id: 'fix-bug',
    title: '修一个必现 Bug',
    prompt: '跑 node --test 时「slugify 保留数字」这条测试失败：标题里的数字被丢掉了。请修好，不要改测试。',
    // 埋的 Bug：字符白名单里漏了数字
    files: { 'src/slug.js': SAMPLE['src/slug.js'].replace('a-z0-9', 'a-z') },
    check: (dir) =>
      all(
        testsPass(dir),
        readFileSync(path.join(dir, 'test/slug.test.js'), 'utf8') === SAMPLE['test/slug.test.js'] || '测试文件被改了',
      ),
  },
  {
    id: 'two-children',
    title: '父对话拆两个子对话',
    prompt: `这次有两件互不相关的事，请分别开两个子对话并行做，两个都合回之后再结束：
1. 在 src/math.js 加 mul(a, b) 返回两数相乘，补测试；
2. 在 src/slug.js 加 unslug(s)，把 - 换成空格（unslug('hello-world') 返回 'hello world'），补测试。`,
    check: (dir) =>
      all(
        testsPass(dir),
        probe(
          dir,
          "import { mul } from './src/math.js'; import { unslug } from './src/slug.js'; if (mul(3,4) !== 12 || unslug('hello-world') !== 'hello world') process.exit(1)",
        ),
      ),
  },
  {
    id: 'reviewed-change',
    title: '带评审的改动',
    prompt:
      '在 src/math.js 加 clamp(x, lo, hi)，把 x 限制在 [lo, hi] 里，补测试。改完先派评审看一遍，评审通过了再结束。',
    check: (dir) =>
      all(
        testsPass(dir),
        probe(
          dir,
          "import { clamp } from './src/math.js'; if (clamp(5,0,3) !== 3 || clamp(-1,0,3) !== 0 || clamp(2,0,3) !== 2) process.exit(1)",
        ),
      ),
  },
  {
    id: 'ask-first',
    title: '需求含糊要先问',
    prompt: '给项目加一个导出功能。',
    answer:
      '导出成 CSV：在 src/export.js 写 toCsv(rows)，rows 是对象数组，表头取第一行的键，值里有逗号时用双引号包起来；补测试。',
    check: (dir) =>
      all(
        testsPass(dir),
        existsSync(path.join(dir, 'src/export.js')) || '没有 src/export.js',
        probe(
          dir,
          "import { toCsv } from './src/export.js'; const s = toCsv([{a:1,b:'x,y'}]); if (!/^a,b\\r?\\n1,\"x,y\"/.test(s)) process.exit(1)",
        ),
      ),
  },
  {
    id: 'read-only',
    title: '只读问答',
    prompt: '解释一下 src/slug.js 的 slugify 是怎么处理空格和大小写的。只回答，不要改任何文件。',
    check: (dir) => {
      const changed = gitStatus(dir)
      return changed ? `改了文件：${changed.split('\n').join('，')}` : true
    },
  },
]
