/**
 * 消息里哪些行内代码算文件路径：中文名、图片扩展名、带行号要认出来；
 * console.log、a.b、版本号、网址、命令加参数不能变成点了报错的假链接。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang, t } from '@shared/i18n'
import { isImagePath, linkPaths, parsePath } from '@/lib/file-path'

setLang('zh')

const path = (s: string) => parsePath(s)?.path
const line = (s: string) => parsePath(s)?.line

test('parsePath：中文目录和文件名都能认出来（截图里的路径）', () => {
  assert.equal(path('ui-shots/107-对话-图片气泡.png'), 'ui-shots/107-对话-图片气泡.png')
  assert.equal(path('截图.png'), '截图.png')
  assert.equal(path('日志/运行时.log'), '日志/运行时.log')
})

test('parsePath：图片扩展名算路径，也认得出是不是图片', () => {
  for (const s of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a/截图.PNG'])
    assert.equal(path(s), s, `${s} 应该认成路径`)
  assert.equal(isImagePath('ui-shots/107-对话-图片气泡.png'), true)
  assert.equal(isImagePath('web/src/lib/file-path.ts'), false)
  // 服务端不把 svg 当图片返回（会报「不是图片」），点开还是按文本看
  assert.equal(isImagePath('icon.svg'), false)
  assert.equal(path('icon.svg'), 'icon.svg')
})

test('parsePath：带行号、行号列号、Windows 路径', () => {
  assert.deepEqual(parsePath('web/src/lib/file-path.ts:42'), { path: 'web/src/lib/file-path.ts', line: 42 })
  assert.equal(line('src/a.ts:12:5'), 12)
  assert.equal(path('src/a.ts:12:5'), 'src/a.ts')
  assert.deepEqual(parsePath('C:\\work\\proj\\src\\a.ts:7'), { path: 'C:\\work\\proj\\src\\a.ts', line: 7 })
  assert.equal(path('./docs/a.md'), './docs/a.md')
  assert.equal(path('.github/workflows/ci.yml'), '.github/workflows/ci.yml')
})

test('parsePath：文件名里的 # - _ @ 和空格不影响识别', () => {
  assert.equal(path('img#1.png'), 'img#1.png')
  assert.equal(path('assets/my-shot_2@2x.png'), 'assets/my-shot_2@2x.png')
  assert.equal(path('shots/我的 截图.png'), 'shots/我的 截图.png')
  // 绝对路径第一段可以带空格（C:/Program Files/a.txt），相对路径的第一段不行：那是命令和参数
  assert.equal(path('C:/Program Files/x/config.json'), 'C:/Program Files/x/config.json')
})

test('parsePath：网址、命令、代码、版本号、普通句子都不是路径', () => {
  for (const s of [
    'console.log',
    'a.b',
    '1.2.3',
    'https://example.com/a.png',
    'http://a.com',
    '//example.com/a.png',
    'www.example.com/a.png',
    'vscode://file/tmp/a.ts',
    'git push origin dev',
    'npm run build',
    'node scripts/e2e.mjs',
    'curl https://example.com/a.png',
    '这是一个句子',
    '这是一句话。',
    'README',
    './',
    '',
    '   ',
  ])
    assert.equal(parsePath(s), null, `「${s}」不该认成路径`)
})

test('linkPaths：行内代码标成可点，代码块里和不像路径的不动', () => {
  const html =
    '<p>截图：<code>ui-shots/107-对话-图片气泡.png</code>，改的是 <code>web/src/lib/file-path.ts:42</code>，' +
    '不是 <code>console.log</code> 也不是 <code>1.2.3</code></p>' +
    '<pre><code>ui-shots/107-对话-图片气泡.png</code></pre>' +
    '<div class="md-code"><div class="md-code-bar"><span>ts</span></div><pre><code class="hljs">src/a.ts</code></pre></div>'
  const out = linkPaths(html)
  assert.match(
    out,
    new RegExp(
      `<code class="md-path" role="button" tabindex="0" data-path="ui-shots/107-对话-图片气泡.png" title="${t('查看图片')}">`,
    ),
  )
  assert.match(out, /data-path="web\/src\/lib\/file-path.ts" data-line="42"/)
  assert.match(out, new RegExp(`title="${t('查看文件')}">web/src/lib/file-path.ts:42</code>`))
  assert.ok(out.includes('<code>console.log</code>'), 'console.log 不该变成链接')
  assert.ok(out.includes('<code>1.2.3</code>'), '版本号不该变成链接')
  // 代码块里的原样保留（外面那层 <pre> 整个跳过）
  assert.ok(out.includes('<pre><code>ui-shots/107-对话-图片气泡.png</code></pre>'), '代码块里的路径不该被标成链接')
  assert.ok(out.includes('<code class="hljs">src/a.ts</code>'), '带语言栏的代码块不该被标成链接')
  assert.equal(out.match(/md-path/g)?.length, 2)
})

test('linkPaths：转义过的字符还原后再判断，属性里的 & 和引号再转义回去', () => {
  const out = linkPaths('<p><code>a&amp;b/x.ts</code> 和 <code>&lt;div&gt;</code></p>')
  assert.match(out, /data-path="a&amp;b\/x.ts"/)
  assert.ok(out.includes('<code>&lt;div&gt;</code>'), '转义后的 HTML 不是路径')
})
