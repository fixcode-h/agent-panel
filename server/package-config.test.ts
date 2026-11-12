import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { packagesApi } from './cli/packages.ts'

/** ADR 0050 第四期：资源开关、内置扩展开关写进 Pi 的 settings.json，项目里的插件读项目自己的配置 */
test('插件细项：资源只列包里有的类型、改了写回；内置扩展开关不动别的键；带 projectId 读项目里的插件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-pkgcfg-'))
  const old = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  const proj = path.join(dir, 'proj')
  const app = packagesApi({ projectPath: async (id) => (id === 'p1' ? proj : '') })
  const call = async (method: string, url: string, body?: object) => {
    const r = await app.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, json: (await r.json()) as any }
  }
  try {
    const file = path.join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ packages: ['npm:tools'], theme: 'dark' }))
    const pkg = path.join(dir, 'npm', 'node_modules', 'tools')
    await mkdir(path.join(pkg, 'skills'), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ pi: { extensions: ['./x.ts'] } }))
    const res = await call('GET', '/pi/packages/resources?source=npm%3Atools')
    assert.deepEqual(
      res.json.map((x: any) => [x.type, x.on]),
      [
        ['extensions', true],
        ['skills', true],
      ],
      '只列包里有的：manifest 写了扩展，目录里有 skills',
    )
    assert.equal(
      (await call('PUT', '/pi/packages/resources', { source: 'npm:tools', type: 'skills', on: false })).status,
      200,
    )
    await call('PUT', '/pi/builtins', { id: 'llama.cpp', on: false })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved, {
      packages: [{ source: 'npm:tools', skills: [] }],
      theme: 'dark',
      extensions: ['-builtin:llama.cpp'],
    })
    assert.equal((await call('GET', '/pi/builtins')).json['llama.cpp'], false)
    await mkdir(path.join(proj, '.pi'), { recursive: true })
    await writeFile(path.join(proj, '.pi', 'settings.json'), JSON.stringify({ packages: ['npm:team-tool'] }))
    assert.deepEqual(
      (await call('GET', '/pi/packages?projectId=p1')).json.map((p: any) => p.source),
      ['npm:team-tool'],
    )
    assert.equal((await call('GET', '/pi/packages?projectId=nope')).status, 400, '项目没有目录')
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = old
    await rm(dir, { recursive: true, force: true })
  }
})
