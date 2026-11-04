import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getCli } from '../shared/clis.ts'
import { Settings } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { listPackages, packageCommandEnv } from './cli-packages.ts'
import { childEnv } from './exec/process.ts'

test('扩展包：读 CLI 配置文件里的列表，相对路径按配置文件所在目录换成绝对路径；npm 包读装着的版本', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-pkg-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    const def = getCli('pi') as Parameters<typeof listPackages>[0]
    assert.deepEqual(await listPackages(def), [], '没有配置文件就是一个都没装')
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        packages: ['npm:@x/tools', '../local-pkg', { source: 'git:github.com/x/y@v1', autoload: false }, 3],
      }),
    )
    // npm 包装在 Pi 的 npm 目录里：读出版本，设置页和 npm 上的最新版比（ADR 0050）
    mkdirSync(path.join(dir, 'npm', 'node_modules', '@x', 'tools'), { recursive: true })
    writeFileSync(path.join(dir, 'npm', 'node_modules', '@x', 'tools', 'package.json'), '{"version":"1.2.3"}')
    assert.deepEqual(await listPackages(def), [
      { source: 'npm:@x/tools', target: 'npm:@x/tools', version: '1.2.3' },
      // pi remove 认的是解析后的路径，原样的相对路径从别的目录跑会找不到
      { source: '../local-pkg', target: path.resolve(dir, '../local-pkg') },
      { source: 'git:github.com/x/y@v1', target: 'git:github.com/x/y@v1' },
    ])
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
  }
})

test('插件：装、删、更新不带「离线运行」的 PI_OFFLINE，不然 pi update 什么都不做还报成功', () => {
  const def = getCli('pi') as Parameters<typeof listPackages>[0]
  const cs = cliSettings(Settings.parse({}), 'pi')
  // 执行时照旧离线：开关管的是对话里 Pi 自己联网
  assert.equal(childEnv(cs.env).PI_OFFLINE, '1')
  // Pi 只认 1 / true / yes 是离线，空串就是不离线
  assert.equal(childEnv(packageCommandEnv(def, cs.env)).PI_OFFLINE, '')
  // 用户自己的环境变量照样带上
  const mine = cliSettings(
    Settings.parse({ clis: { pi: { env: [{ key: 'NPM_CONFIG_REGISTRY', value: 'r' }] } } }),
    'pi',
  )
  assert.equal(childEnv(packageCommandEnv(def, mine.env)).NPM_CONFIG_REGISTRY, 'r')
})
