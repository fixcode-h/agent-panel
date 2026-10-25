import assert from 'node:assert/strict'
import test from 'node:test'
import { stripAnsi } from './ansi.ts'

/** 转义写成 \u001b，读代码时看得清 ESC 在哪 */
const esc = '\u001b'

test('SGR 颜色：Command Code 打印的登录提示', () => {
  const raw = [
    '',
    '✓ Authenticated',
    '',
    `${esc}[32m✓${esc}[39m ${esc}[1mAlready logged in${esc}[22m，用户 ${esc}[36mfixcode-h${esc}[39m`,
    '',
    `${esc}[2mRun${esc}[22m ${esc}[36mcmdc${esc}[39m ${esc}[2mto get started.${esc}[22m`,
    '',
  ].join('\n')
  assert.equal(
    stripAnsi(raw),
    ['', '✓ Authenticated', '', '✓ Already logged in，用户 fixcode-h', '', 'Run cmdc to get started.', ''].join('\n'),
  )
})

test('加粗、暗色的开关对：ESC[1m … ESC[22m、ESC[2m … ESC[22m', () => {
  assert.equal(stripAnsi(`${esc}[1m粗${esc}[22m 和 ${esc}[2m暗${esc}[22m`), '粗 和 暗')
})

test('光标移动、清屏、256 色和真彩色', () => {
  assert.equal(stripAnsi(`${esc}[2J${esc}[1;1H好了${esc}[K`), '好了')
  assert.equal(stripAnsi(`${esc}[38;5;196m红${esc}[0m`), '红')
  assert.equal(stripAnsi(`${esc}[38;2;255;0;0m红${esc}[m`), '红')
})

test('8 位 CSI（单个 0x9B 引导，后面不跟 [）也清掉', () => {
  const csi = String.fromCharCode(0x9b)
  assert.equal(stripAnsi(csi + '32m红' + csi + '39m字'), '红字')
  assert.equal(stripAnsi(csi + '2J' + csi + '1;1H好了'), '好了')
})

test('普通方括号文本原样保留', () => {
  const text = '看 [32m 不是转义，[1m] 也不是；[链接](https://example.com/a) 和 [全局设置] 都要留着。'
  assert.equal(stripAnsi(text), text)
  // 已经干净的文本再过一遍不变
  assert.equal(stripAnsi(stripAnsi(`${esc}[32mok${esc}[39m [32m 别动`)), 'ok [32m 别动')
})

test('窗口标题（OSC）和两字符转义也清掉', () => {
  const st = `${esc}\u005c` // OSC 的结尾是 ESC 加反斜杠
  assert.equal(stripAnsi(`${esc}]0;cmdc login${'\u0007'}完成`), '完成')
  assert.equal(stripAnsi(`${esc}]8;;https://example.com${st}点这里${esc}]8;;${st}`), '点这里')
  assert.equal(stripAnsi(`${esc}(B正常${esc}=`), '正常')
})

test('进度条回到行首的 \r 去掉，真换行（\r\n）保留成 \n', () => {
  assert.equal(stripAnsi('下载中 50%\r下载中 100%\r\n完成'), '下载中 50%下载中 100%\n完成')
})

test('空字符串和纯文本不变', () => {
  assert.equal(stripAnsi(''), '')
  assert.equal(stripAnsi('Already logged in'), 'Already logged in')
})
