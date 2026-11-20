/**
 * 插件拿项目文档根（插件接口 15）：按项目 id 找到项目再交给接线算，项目不存在或没有目录时给 undefined。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Project } from '../../shared/schema.ts'
import { configureProjectGate, pluginProjectsApi } from './project-gate.ts'

test('docRoot 按项目交给接线算，找不到项目或没有目录时为 undefined', async () => {
  const projects = [
    { id: 'a', name: 'A', path: 'D:/P4/Main/Game' },
    { id: 'b', name: 'B', path: '' },
  ] as unknown as Project[]
  const asked: string[] = []
  configureProjectGate({
    projects: async () => projects,
    manifest: () => undefined,
    setCapabilities: async () => undefined,
    docRoot: async (p) => {
      asked.push(p.id)
      return 'D:/P4/ProjectDoc/docs'
    },
  })
  const api = pluginProjectsApi('ue')
  assert.equal(await api.docRoot?.('a'), 'D:/P4/ProjectDoc/docs')
  assert.equal(await api.docRoot?.('b'), undefined)
  assert.equal(await api.docRoot?.('nope'), undefined)
  assert.deepEqual(asked, ['a'])
})
