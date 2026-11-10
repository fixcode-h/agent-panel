/**
 * diff 的统一画法（用户 2026-11-10 要求照 Claude Code，所有 diff 一个样子）：
 * 一列行号、+/− 记号、去掉记号的代码；不画 @@ 段头，段与段之间「⋯ 第 n 行」；Markdown 的 ```diff 也走这一套
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffRowsHtml, hunkLabel, parseDiff } from '@/lib/diff-html'
import { clearDocCache, renderDoc } from '@/lib/workflow-doc'

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
@@ -40,2 +40,3 @@ function f() {
   x()
+  y()
   z()
`

test('拆行：文件头不要，行号加的行和上下文写改后的、删的行写改前的；段头记下从第几行起', () => {
  const rows = parseDiff(DIFF)!
  assert.deepEqual(
    rows.map((r) => [r.kind, r.n, r.text]),
    [
      ['hunk', 1, ''],
      ['ctx', 1, 'const a = 1'],
      ['del', 2, 'const b = 2'],
      ['add', 2, 'const b = 3'],
      ['ctx', 3, 'const c = 4'],
      ['hunk', 40, 'function f() {'],
      ['ctx', 40, '  x()'],
      ['add', 41, '  y()'],
      ['ctx', 42, '  z()'],
    ],
  )
  assert.equal(parseDiff('说明文字\n+x', true), null, '夹着别的文字的不当 diff')
  assert.equal(hunkLabel('@@ -40,2 +40,3 @@ function f() {'), '⋯ 第 40 行  function f() {')
})

test('画出来：不出现 @@，第一段从第 1 行开始不画分隔，后面的段画「⋯ 第 n 行」；记号是 + 和 −，不进代码', () => {
  const html = diffRowsHtml(parseDiff(DIFF)!)
  assert.doesNotMatch(html, /@@/)
  assert.equal(html.match(/cdiff-hunk/g)?.length, 1)
  assert.match(html, /⋯ 第 40 行<span class="cdiff-ctx">function f\(\) \{<\/span>/)
  assert.match(
    html,
    /<div class="cdiff-row cdiff-del"><span class="cdiff-n" aria-hidden="true">2<\/span><span class="cdiff-s" aria-hidden="true">−<\/span><span class="cdiff-c">const b = 2<\/span><\/div>/,
  )
  // 没有 @@ 行号的（自己比出来的改前改后）：不画行号那一栏
  assert.doesNotMatch(diffRowsHtml([{ kind: 'add', text: 'x' }]), /cdiff-n/)
})

test('Markdown 的 ```diff：顶栏写文件名和增删数，复制用原文；不是 diff 的照普通代码块', () => {
  clearDocCache()
  const html = renderDoc('```diff file=web%2Fsrc%2Fa.ts\n@@ -1 +1 @@\n-old\n+new\n```', new Set())
  assert.match(html, /class="md-code md-diff"/)
  assert.match(html, /<span class="md-code-lang">a\.ts<\/span>/)
  assert.match(html, /cdiff-stat-add">\+1<\/span> <span class="cdiff-stat-del">−1/)
  assert.match(html, /data-src="@@ -1 \+1 @@\n-old\n\+new"/)
  assert.doesNotMatch(renderDoc('```diff\n说明\n+x\n```', new Set()), /md-diff/)
})
