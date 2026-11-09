import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import { parseRepo } from './github.ts'
import { packageRoot, parseManifest } from './store.ts'
import { readZip, safeRel } from './zip.ts'

/** 拼一个最小的 zip（deflate），和插件仓库 scripts/zip.mjs 打出来的格式一样 */
function makeZip(files: Record<string, string>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [n, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const name = Buffer.from(n)
    const body = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const manifest = (extra: Record<string, unknown> = {}) => ({ id: 'demo', name: 'Demo', version: '1.0.0', ...extra })

test('插件包 zip：deflate 解得开，GitHub 源码包外面那层「仓库名-ref/」能剥掉，子目录能指定', () => {
  const files = readZip(
    makeZip({
      'agent-plugins-main/README.md': '# x',
      'agent-plugins-main/demo/plugin.json': JSON.stringify(manifest()),
      'agent-plugins-main/demo/web/index.js': 'export default () => ({})',
    }),
  )
  assert.equal(files.find((f) => f.name.endsWith('index.js'))?.data.toString(), 'export default () => ({})')
  assert.equal(packageRoot(files, 'demo'), 'agent-plugins-main/demo/')
  assert.throws(() => packageRoot(files), /包里没有 plugin\.json/)
  // Release 附件：包根就是 zip 根
  assert.equal(packageRoot(readZip(makeZip({ 'plugin.json': '{}' }))), '')
  assert.throws(() => readZip(Buffer.from('not a zip')), /不是 zip 文件/)
})

test('包里的路径不许跳出包目录', () => {
  assert.ok(safeRel('web/index.js'))
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\..\\x']) assert.ok(!safeRel(bad), bad)
})

test('清单：保留的 id、接口版本、和内置模板撞 key 的、入口跳出包目录的都拒绝', () => {
  assert.equal(parseManifest(manifest()).id, 'demo')
  assert.throws(() => parseManifest(manifest({ id: 'market' })), /market/)
  assert.throws(() => parseManifest(manifest({ id: 'Bad Id' })), /plugin\.json 格式不对/)
  assert.throws(() => parseManifest(manifest({ api: 99 })), /接口版本|99/)
  assert.throws(
    () =>
      parseManifest(
        manifest({ agents: [{ key: 'developer', category: '开发', agent: { name: 'x', instructions: 'x' } }] }),
      ),
    /developer/,
  )
  assert.throws(() => parseManifest(manifest({ server: '../evil.js' })), /evil/)
})

test('GitHub 地址：owner/repo、完整链接、带分支和子目录的链接都认', () => {
  assert.deepEqual(parseRepo('fixcode-h/agent-plugins'), { repo: 'fixcode-h/agent-plugins' })
  assert.deepEqual(parseRepo('https://github.com/fixcode-h/agent-plugins.git'), { repo: 'fixcode-h/agent-plugins' })
  assert.deepEqual(parseRepo('https://github.com/a/b/tree/dev/plugins/x'), {
    repo: 'a/b',
    ref: 'dev',
    path: 'plugins/x',
  })
  assert.throws(() => parseRepo('not a repo'), /owner\/repo/)
})
