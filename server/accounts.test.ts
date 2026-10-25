import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：accounts.ts 在模块顶层就算数据目录，不能碰真正的 ~/.agent-panel
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-accounts-'))

// 界面语言固定成中文：断言里有 t() 算出来的文案（项目教训 lmvjrq7zym1eq）
const { setLang } = await import('../shared/i18n.ts')
setLang('zh')

const { loginOutcome, loginFailure } = await import('./accounts.ts')
const { t } = await import('../shared/i18n.ts')
const { stripAnsi } = await import('../shared/ansi.ts')
const { getCli } = await import('../shared/clis.ts')

/**
 * 登录判定：已经登录着再点登录时，Command Code 这类 CLI 只会说「已登录」、退出码 0、不改凭据文件。
 * 这种不能按「凭据变了没有」判，否则会把本来好好的登录报成失败；真正的失败仍然要报失败。
 */

/** 一次登录进程的结局，默认是一次成功的登录（凭据变了） */
const outcome = (o: Partial<Parameters<typeof loginOutcome>[0]> = {}) =>
  loginOutcome({ code: 0, killed: null, before: '', after: 'new', alreadyLoggedIn: false, ...o })

test('凭据变了就算登录成功（默认路径不变）', () => {
  assert.equal(outcome({ before: 'old', after: 'new' }), 'done')
  assert.equal(outcome({ before: '', after: 'new' }), 'done')
})

test('退出码 0、凭据没变，标了 loginAlreadyLoggedIn 的 CLI 算成功', () => {
  // Command Code 的 cmdc login 在已登录时就这样：输出 Already logged in，退出码 0，auth.json 一个字节都不改
  assert.equal(outcome({ before: 'same', after: 'same', alreadyLoggedIn: true }), 'done')
  assert.equal(outcome({ before: '', after: 'same', alreadyLoggedIn: true }), 'done')
})

test('没标这个字段的 CLI 仍然按凭据判断：没变就是没登进去', () => {
  assert.equal(outcome({ before: 'same', after: 'same', alreadyLoggedIn: false }), 'unchanged')
})

test('真正的失败照样失败：退出码非 0', () => {
  assert.equal(outcome({ code: 1, before: 'same', after: 'same', alreadyLoggedIn: true }), 'unchanged')
  assert.equal(outcome({ code: 1, before: '', after: undefined, alreadyLoggedIn: true }), 'no-credential')
})

test('退出码 0 但读不到凭据：还是没登录', () => {
  assert.equal(outcome({ before: '', after: undefined, alreadyLoggedIn: true }), 'no-credential')
  assert.equal(outcome({ before: 'old', after: undefined, alreadyLoggedIn: false }), 'no-credential')
})

test('进程没起来、用户取消各有各的结局', () => {
  assert.equal(outcome({ spawnError: 'spawn cmdc ENOENT', after: undefined }), 'spawn-error')
  assert.equal(outcome({ code: null, killed: 'stopped', before: 'same', after: 'same' }), 'cancelled')
  // 超时被停掉不算取消，仍然是没完成
  assert.equal(outcome({ code: null, killed: 'timeout', before: 'same', after: 'same' }), 'unchanged')
})

test('失败文案分开：退出码 0 但没凭据要说「没有找到登录凭据」', () => {
  const out = 'Already logged in'
  // 用户关掉了浏览器里的授权页：CLI 以 0 退出、什么都没写 → 是「没凭据」，不是「没完成登录」
  assert.equal(
    loginFailure({ outcome: 'no-credential', cli: 'Command Code', code: 0, output: out }),
    [t('登录没有完成：没有找到登录凭据'), out].join('\n'),
  )
  // 有凭据但没变、CLI 也没说已登录（没开 loginAlreadyLoggedIn）：CLI 没把登录做下去
  assert.equal(
    loginFailure({ outcome: 'unchanged', cli: 'Command Code', code: 0, output: out }),
    [t('{cli} 没有完成登录（退出码 {code}）', { cli: 'Command Code', code: '0' }), out].join('\n'),
  )
  // 退出码非 0 保留原来的文案，带上尾部输出方便排查
  assert.match(
    loginFailure({ outcome: 'unchanged', cli: 'Command Code', code: 2, output: out }),
    /退出码 2[\s\S]*Already logged in/,
  )
})

test('退出码非 0 的失败保留退出码，不因为读不到凭据就换成「没有找到登录凭据」', () => {
  const out = 'boom'
  // 未登录时 CLI 自己报错退出：用户最需要看到的是退出码，和改动前一致
  assert.equal(
    loginFailure({ outcome: 'no-credential', cli: 'Command Code', code: 1, output: out }),
    [t('{cli} 没有完成登录（退出码 {code}）', { cli: 'Command Code', code: '1' }), out].join('\n'),
  )
  // 退出码 0 且没凭据（用户关掉了授权页）才是「没有找到登录凭据」
  assert.equal(
    loginFailure({ outcome: 'no-credential', cli: 'Command Code', code: 0, output: out }),
    [t('登录没有完成：没有找到登录凭据'), out].join('\n'),
  )
})

test('失败文案：取消、启动失败、成功各是各的', () => {
  assert.equal(loginFailure({ outcome: 'cancelled', cli: 'Command Code', code: null, output: 'x' }), t('已取消'))
  assert.equal(
    loginFailure({ outcome: 'spawn-error', cli: 'Command Code', code: null, output: 'x', error: 'spawn cmdc ENOENT' }),
    'spawn cmdc ENOENT',
  )
  assert.equal(loginFailure({ outcome: 'done', cli: 'Command Code', code: 0, output: 'x' }), '')
})

test('失败文案里没有尾部输出时不留下空行', () => {
  assert.equal(
    loginFailure({ outcome: 'no-credential', cli: 'Command Code', code: 0, output: '   ' }),
    t('登录没有完成：没有找到登录凭据'),
  )
})

test('凭据已经写入、用户又点了取消：算成功，不因为取消把结果吞掉', () => {
  // 原来的代码就是凭据优先：登录真成功了，取消只是不等进度了
  assert.equal(outcome({ code: null, killed: 'stopped', before: 'old', after: 'new' }), 'done')
  assert.equal(outcome({ code: null, killed: 'stopped', before: '', after: 'new' }), 'done')
  // 凭据没变、用户取消才算取消
  assert.equal(outcome({ code: null, killed: 'stopped', before: 'same', after: 'same' }), 'cancelled')
})

test('Command Code 的定义开了 loginAlreadyLoggedIn，别的 CLI 没开', () => {
  assert.equal(getCli('commandcode')?.auth?.loginAlreadyLoggedIn, true)
  for (const id of ['claude', 'codex', 'gemini', 'pi'])
    assert.equal(getCli(id)?.auth?.loginAlreadyLoggedIn, false, `${id} 不该开这个字段`)
})

test('登录输出里的 ANSI 转义在存进 job.output 之前就清掉', () => {
  const esc = '\u001b'
  const raw = `${esc}[32m✓${esc}[39m ${esc}[1mAlready logged in${esc}[22m，用户 ${esc}[36mfixcode-h${esc}[39m`
  const clean = stripAnsi(raw)
  assert.equal(clean, '✓ Already logged in，用户 fixcode-h')
  // 报错文案里那 3 行尾部输出用的是同一份干净文本，不会再出现 [32m 这类残码
  assert.doesNotMatch(clean, /\[\d+m/)
})
