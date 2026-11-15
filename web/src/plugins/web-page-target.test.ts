/**
 * 插件接口 11 的 webPages：清单里的 url 换成网页框的目标。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webPageTarget } from './web-page-target'

test('webPages 的地址：托管进程、包里的文件、外部网址', () => {
  assert.deepEqual(webPageTarget('draw', 'service:app/'), {
    kind: 'plugin-service',
    plugin: 'draw',
    service: 'app',
    path: '/',
  })
  assert.deepEqual(webPageTarget('draw', 'service:app/board?x=1'), {
    kind: 'plugin-service',
    plugin: 'draw',
    service: 'app',
    path: '/board?x=1',
  })
  assert.deepEqual(webPageTarget('draw', 'file:site/index.html'), {
    kind: 'plugin-file',
    plugin: 'draw',
    path: 'site/index.html',
  })
  assert.deepEqual(webPageTarget('draw', 'https://example.com/'), { kind: 'url', url: 'https://example.com/' })
})
