/** 插件「一键更新」：不弹确认、按顺序直接换上，失败的记原因、不挡后面的 */
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { pluginApi, type InstallPreview } from '@/plugins/api'
import { updateAll } from '@/plugins/update-all'
import { pluginUpdatesState } from '@/plugins/updates'

test('updateAll：逐个下载并直接确认安装，失败的那个记下原因，其余照常装好', async () => {
  const order: string[] = []
  mock.method(pluginApi, 'fromGithub', async ({ id }: { id?: string }) => {
    order.push(`get:${id}`)
    if (id === 'bad') throw new Error('下载失败')
    return { token: `tk-${id}` } as InstallPreview
  })
  mock.method(pluginApi, 'confirm', async (token: string) => {
    order.push(`ok:${token}`)
    return { ok: true as const }
  })
  const u = (id: string) => ({ id, current: '1.0.0', latest: '1.1.0', install: { repo: 'o/r', id } })
  await updateAll([u('a'), u('bad'), u('c')])
  assert.deepEqual(order, ['get:a', 'ok:tk-a', 'get:bad', 'get:c', 'ok:tk-c'])
  const bulk = pluginUpdatesState().bulk
  assert.deepEqual(bulk.get('a'), { status: 'done', to: '1.1.0' })
  assert.deepEqual(bulk.get('bad'), { status: 'failed', to: '1.1.0', error: '下载失败' })
  assert.equal(bulk.get('c')?.status, 'done')
})
