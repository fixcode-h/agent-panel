import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { merge3 } from './merge3.ts'

const B = (s: string) => Buffer.from(s, 'utf8')
const run = (t: string, o: string, m: string) => {
  const r = merge3(B(t), B(o), B(m))
  return r.kind === 'binary' ? r : { ...r, text: r.out.toString('utf8') }
}

test('三方合并：两边改不同的地方都留下，同一处改法不同写冲突标记，编码和换行原样保留', () => {
  const r = run('a\nB-target\nc\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE-mine\n')
  assert.deepEqual(r, { kind: 'clean', out: B('a\nB-target\nc\nd\nE-mine\n'), text: 'a\nB-target\nc\nd\nE-mine\n' })
  // 改到同一行写 git 同样的冲突标记，两边改成一样的不算冲突
  const c = run('one\nfive-target\n', 'one\nfive\n', 'one\nFIVE\n')
  assert.equal(c.kind, 'conflict')
  assert.equal('text' in c && c.text, 'one\n<<<<<<< target\nfive-target\n=======\nFIVE\n>>>>>>> mine\n')
  assert.equal(run('x\nsame\n', 'x\nold\n', 'x\nsame\n').kind, 'clean')
  // CRLF、中文、结尾没有换行原样保留，冲突标记跟目标的换行
  const crlf = run('标题\r\n目标\r\n尾', '标题\r\n原来\r\n尾', '标题\r\n这次\r\n尾')
  assert.equal('text' in crlf && crlf.text, '标题\r\n<<<<<<< target\r\n目标\r\n=======\r\n这次\r\n>>>>>>> mine\r\n尾')
  const ok = run('新加\r\n标题\r\n原来\r\n尾', '标题\r\n原来\r\n尾', '标题\r\n原来\r\n尾改')
  assert.equal('text' in ok && ok.text, '新加\r\n标题\r\n原来\r\n尾改')
})

test('三方合并：二进制只有一边改过时取改过的那边，两边都改过返回 binary', () => {
  const base = Buffer.from([0, 1, 2, 3])
  const mine = Buffer.from([0, 1, 9, 3])
  assert.deepEqual(merge3(base, base, mine), { kind: 'clean', out: mine })
  assert.deepEqual(merge3(mine, base, mine), { kind: 'clean', out: mine })
  assert.deepEqual(merge3(Buffer.from([0, 7]), base, mine), { kind: 'binary' })
})

test('三方合并：随机改动的结果和 git merge-file 一致', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-merge3-'))
  try {
    // 固定种子的伪随机：失败时能复现
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const edit = (xs: string[]) => {
      const ys = [...xs]
      for (let k = rnd(4); k >= 0; k--) {
        const at = rnd(ys.length + 1)
        const op = rnd(3)
        if (op === 0) ys.splice(at, 1)
        else if (op === 1) ys.splice(at, 0, `n${rnd(1000)}`)
        else ys[at] = `c${rnd(1000)}`
      }
      return ys
    }
    for (let i = 0; i < 300; i++) {
      const base = Array.from({ length: 5 + rnd(30) }, (_, j) => `l${j}`)
      // 两边改的地方隔开：都落在不同位置时两者都应该合得上，结果要逐字一样
      const t = edit(base.slice(0, base.length >> 1)).concat(base.slice(base.length >> 1))
      const m = base.slice(0, (base.length >> 1) + 2).concat(edit(base.slice((base.length >> 1) + 2)))
      const text = (xs: string[]) => xs.filter((x) => x !== undefined).join('\n') + '\n'
      const files = { t: text(t), o: text(base), m: text(m) }
      for (const [k, v] of Object.entries(files)) writeFileSync(path.join(dir, k), v)
      let code = 0
      try {
        execFileSync('git', ['merge-file', '-L', 'target', '-L', 'before', '-L', 'mine', 't', 'o', 'm'], { cwd: dir })
      } catch (e) {
        code = (e as { status: number }).status
      }
      const r = merge3(B(files.t), B(files.o), B(files.m))
      if (code === 0) {
        assert.equal(r.kind, 'clean', JSON.stringify(files))
        assert.equal('out' in r && r.out.toString(), readFileSync(path.join(dir, 't'), 'utf8'))
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
