import assert from 'node:assert/strict'
import test from 'node:test'
import { INTEGRATIONS, authState, getIntegration, type Platform } from '../shared/integrations.ts'

const PLATFORMS: Platform[] = ['win32', 'darwin', 'linux']

/**
 * 所有授权工具共用的结构约束：设置页和接口全靠这些字段，
 * 少一个（例如某个平台没有安装命令）卡片上就会出现空按钮或者跑不了的命令。
 */
test('每个授权工具的定义都完整，三个平台都有安装方式', () => {
  const ids = new Set<string>()
  for (const def of INTEGRATIONS) {
    assert.ok(!ids.has(def.id), `id 重复：${def.id}`)
    ids.add(def.id)
    assert.ok(def.name.trim(), `${def.id} 没有 name`)
    assert.ok(def.command.trim(), `${def.id} 没有 command`)
    assert.ok(def.versionArgs.length, `${def.id} 没有 versionArgs`)
    assert.ok(def.description.trim(), `${def.id} 没有 description`)
    assert.match(def.docsUrl ?? '', /^https:\/\//, `${def.id} 的 docsUrl 不是 https`)
    assert.ok(def.auth.login.length, `${def.id} 没有浏览器授权命令`)
    // 正则写错时运行时只会静默认不到账号/授权码，这里提前编一遍
    for (const key of ['account', 'code', 'ready'] as const) {
      const re = def.auth[key]
      if (re) assert.doesNotThrow(() => new RegExp(re.source, re.flags), `${def.id} 的 ${key} 正则无效`)
    }
    for (const p of PLATFORMS) {
      assert.ok(def.install[p]?.trim(), `${def.id} 在 ${p} 上没有安装命令`)
      if (!def.setup) continue
      const steps = def.setup[p]
      assert.ok(steps?.length, `${def.id} 在 ${p} 上没有一键安装做法`)
      for (const step of steps ?? []) {
        if (step === 'download') assert.ok(def.dataBin, `${def.id} 在 ${p} 上写了 download，但没有 dataBin`)
        else assert.ok(step.length > 0 && step.every((a) => typeof a === 'string' && a), `${def.id} 的安装步骤是空的`)
      }
    }
    for (const env of [def.env, def.quietEnv]) {
      for (const [key, value] of Object.entries(env ?? {})) {
        assert.ok(key, `${def.id} 的环境变量没有名字`)
        assert.equal(typeof value, 'string', `${def.id} 的环境变量 ${key} 不是字符串`)
      }
    }
  }
})

/** vercel@65.2.0 的实际输出：whoami 未登录退出码 1，已登录的 JSON 里带 username */
test('vercel：没登录时是未授权，已登录时能认出账号', () => {
  const def = getIntegration('vercel')
  if (!def) throw new Error('没有 vercel 定义')
  const state = (output: string, code: number) => authState(def, code, output)
  // vercel whoami --format json：未登录（退出码 1）
  assert.deepEqual(state('{\n  "loggedIn": false,\n  "cliVersion": "65.2.0",\n  "linkedProject": null\n}', 1), {
    authed: false,
    account: '',
  })
  // 已登录：源码里 jsonOutput.username 是 Vercel 用户名
  assert.deepEqual(
    state('{\n  "team": null,\n  "plan": "hobby",\n  "username": "demo-user",\n  "email": "demo@example.com"\n}', 0),
    { authed: true, account: 'demo-user' },
  )
  // 退出码 0 但输出里认不出账号时，不编一个账号出来
  assert.deepEqual(state('Logged in as demo (cached)', 0), { authed: true, account: '' })
})

test('vercel：命令、授权方式和环境变量按 CLI 的实际能力配', () => {
  const def = getIntegration('vercel')
  if (!def) throw new Error('没有 vercel 定义')
  assert.equal(def.command, 'vercel')
  assert.deepEqual(def.versionArgs, ['--version'])
  assert.equal(def.docsUrl, 'https://vercel.com/docs/cli')
  assert.deepEqual(def.auth.status, ['whoami', '--format', 'json'])
  assert.deepEqual(def.auth.login, ['login'])
  assert.deepEqual(def.auth.logout, ['logout'])
  // vercel 没有把 token 存进凭据的子命令（--token / VERCEL_TOKEN 只对单次命令生效），
  // 配了 token 面板就会展示一个其实授权不了任何东西的入口
  assert.equal(def.auth.token, undefined)
  assert.equal(def.env?.NO_UPDATE_NOTIFIER, '1')
  assert.equal(def.env?.VERCEL_TELEMETRY_DISABLED, '1')
  // device code flow 打印的授权链接里的 user_code 就是要用户输入的授权码
  const output = '  Visit https://vercel.com/oauth/device?user_code=ABCD-1234\n'
  assert.equal(output.match(def.auth.code!)?.[1], 'ABCD-1234')
})
