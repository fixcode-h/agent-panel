// scripts/release-publish.mjs 的测试：用假的 gh 调用模拟 504、4xx、已存在但缺产物这些情况
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isRetryableError,
  missingAssets,
  parseArgs,
  publishRelease,
  toTag,
  RETRY_DELAYS_MS,
} from './release-publish.mjs'

const ASSETS = [
  'release/agent-panel-0.28.1420.zip',
  'release/agent-panel-0.28.1420-mac.tar.gz',
  'release/agent-panel-0.28.1420-mac.zip',
  'release/agent-panel-0.28.1420-linux.tar.gz',
  'release/SHA256SUMS',
]
const ASSET_NAMES = ASSETS.map((p) => p.split('/').pop())

/** 假的 gh：按子命令（view / create / upload）分发，记录每次调用的参数 */
function fakeGh(handlers) {
  const calls = []
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'gh')
    calls.push(args)
    const kind = args[1]
    const handler = handlers[kind]
    if (!handler) throw new Error(`没有为 gh ${kind} 准备响应`)
    const times = calls.filter((a) => a[1] === kind).length
    return handler(args, times)
  }
  const count = (kind) => calls.filter((a) => a[1] === kind).length
  return { calls, count, exec }
}

/** 每个产物在测试里都当作 100 字节（真实字节数由注入的 statSize 提供） */
const ASSET_SIZE = 100

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const fail = (stderr) => ({ status: 1, stdout: '', stderr })
const notFound = () => fail('release not found')
/** gh 返回的是 `资产名\t字节数` */
const exists = (names) => ok(names.map((n) => `${n}\t${ASSET_SIZE}`).join('\n'))

const HTTP_504 =
  "HTTP 504: We couldn't respond to your request in time. Sorry about that. (https://api.github.com/repos/fixcode-h/agent-panel/releases/423999936)"

async function publish(gh) {
  const slept = []
  const logs = []
  const result = await publishRelease({
    version: '0.28.1420',
    assets: ASSETS,
    target: 'deadbeef',
    notesFile: 'release/notes.md',
    exec: gh.exec,
    sleep: async (ms) => slept.push(ms),
    log: (m) => logs.push(m),
    statSize: () => ASSET_SIZE,
  })
  return { result, slept, logs }
}

test('创建撞上 504 时先确认有没有建出来，不存在再重试创建', async () => {
  const gh = fakeGh({
    view: notFound,
    create: (_args, times) =>
      times === 1 ? fail(HTTP_504) : ok('https://github.com/fixcode-h/agent-panel/releases/1'),
  })
  const { result, slept, logs } = await publish(gh)

  assert.equal(gh.count('view'), 2, '每次创建前都要查一次是否已存在')
  assert.equal(gh.count('create'), 2)
  assert.deepEqual(slept, [RETRY_DELAYS_MS[0]])
  assert.equal(result.created, true)
  // 创建参数要和原来 workflow 里那段 bash 一致：5 个产物 + --target / --title / --notes-file / --latest
  const create = gh.calls.find((a) => a[1] === 'create')
  assert.deepEqual(create.slice(2, 3), ['v0.28.1420'])
  assert.deepEqual(create.slice(3, 3 + ASSETS.length), ASSETS)
  assert.deepEqual(create.slice(3 + ASSETS.length), [
    '--target',
    'deadbeef',
    '--title',
    'v0.28.1420',
    '--notes-file',
    'release/notes.md',
    '--latest',
  ])
  assert.ok(
    logs.some((l) => l.includes('HTTP 504') && l.includes('重试')),
    '重试前要把上一次的错误和等待写进日志',
  )
})

test('504 但其实已经建成了：直接当成功，不再重复创建', async () => {
  const gh = fakeGh({
    // 第一次查不到（创建前），创建返回 504；第二次查到已经建好且产物齐全
    view: (_args, times) => (times === 1 ? notFound() : exists(ASSET_NAMES)),
    create: () => fail(HTTP_504),
  })
  const { result, logs } = await publish(gh)

  assert.equal(gh.count('create'), 1, '确认已存在后不能再 create 一次')
  assert.equal(gh.count('upload'), 0)
  assert.equal(result.existed, true)
  assert.equal(result.created, false)
  assert.ok(
    logs.some((l) => l.includes('已经存在') && l.includes('产物齐全')),
    '已存在不能静默跳过，日志里要写清楚',
  )
})

test('已存在但产物不全：只补齐缺的那几个，用 --clobber', async () => {
  const partial = [ASSET_NAMES[0], ASSET_NAMES[1]]
  const gh = fakeGh({
    view: () => exists(partial),
    upload: () => ok(),
  })
  const { result, logs } = await publish(gh)

  const upload = gh.calls.find((a) => a[1] === 'upload')
  assert.ok(upload, '缺产物时要调用 gh release upload')
  assert.equal(upload[2], 'v0.28.1420')
  assert.deepEqual(upload.slice(3, -1), ASSETS.slice(2), '只传缺的那三个产物')
  assert.equal(upload.at(-1), '--clobber')
  assert.deepEqual(result.uploaded, ASSET_NAMES.slice(2))
  assert.ok(logs.some((l) => l.includes('缺少产物')))
})

test('已存在且产物齐全：不创建也不上传，日志写清楚', async () => {
  const gh = fakeGh({ view: () => exists(ASSET_NAMES) })
  const { result, slept, logs } = await publish(gh)

  assert.equal(gh.count('create'), 0)
  assert.equal(gh.count('upload'), 0)
  assert.deepEqual(slept, [])
  assert.equal(result.existed, true)
  assert.equal(result.created, false)
  assert.ok(logs.some((l) => l.includes('已经存在') && l.includes('不重复创建')))
})

test('4xx 不重试：直接失败并保留原始报错', async () => {
  const gh = fakeGh({
    view: notFound,
    create: () =>
      fail(
        'HTTP 422: Validation Failed (https://api.github.com/repos/fixcode-h/agent-panel/releases)\ntag_name already exists',
      ),
  })
  const slept = []
  await assert.rejects(
    () =>
      publishRelease({
        version: '0.28.1420',
        assets: ASSETS,
        exec: gh.exec,
        sleep: async (ms) => slept.push(ms),
        log: () => {},
        statSize: () => ASSET_SIZE,
      }),
    (e) => e.message.includes('不重试') && e.message.includes('tag_name already exists'),
  )
  assert.equal(gh.count('create'), 1)
  assert.deepEqual(slept, [], '4xx 不能等退避')
})

test('重试次数用完仍然失败：把原始报错一起抛出来', async () => {
  const gh = fakeGh({ view: notFound, create: () => fail('HTTP 502: Bad Gateway') })
  await assert.rejects(
    () => publish(gh),
    (e) => e.message.includes(`重试 ${RETRY_DELAYS_MS.length} 次`) && e.message.includes('HTTP 502'),
  )
  assert.equal(gh.count('create'), RETRY_DELAYS_MS.length + 1)
})

test('查询本身撞上 5xx 时先重试查询，不冒然创建', async () => {
  const gh = fakeGh({
    view: (_args, times) => (times === 1 ? fail(HTTP_504) : exists(ASSET_NAMES)),
    create: () => ok(),
  })
  const { result, slept } = await publish(gh)

  assert.equal(gh.count('create'), 0, '查不出状态时不能新建，可能建出重复的')
  assert.deepEqual(slept, [RETRY_DELAYS_MS[0]])
  assert.equal(result.existed, true)
})

test('补齐产物撞上 5xx 时重试后再补', async () => {
  const gh = fakeGh({
    view: () => exists([ASSET_NAMES[0]]),
    upload: (_args, times) => (times === 1 ? fail('HTTP 503: Service Unavailable') : ok()),
  })
  const { result, slept } = await publish(gh)

  assert.equal(gh.count('upload'), 2)
  assert.deepEqual(slept, [RETRY_DELAYS_MS[0]])
  assert.equal(result.uploaded.length, ASSETS.length - 1)
})

test('可重试的错误：5xx、超时、网络（含 gh 的 Go 文本）', () => {
  for (const text of [
    HTTP_504,
    'HTTP 500: Internal Server Error',
    'HTTP 502: Bad Gateway',
    'request timed out',
    'Timeout waiting for response',
    // gh 是 Go 写的，这些是它真实会打的文本，不是 Node 的 errno 名
    'dial tcp: lookup api.github.com: no such host',
    'dial tcp 140.82.113.6:443: i/o timeout',
    'context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
    'net/http: TLS handshake timeout',
    'read: connection reset by peer',
    'transport is closing',
    'unexpected EOF',
    'http2: client connection lost',
  ]) {
    assert.ok(isRetryableError(text), `${text} 应该重试`)
  }
})

test('不重试的错误：4xx 和本地参数错误', () => {
  for (const text of [
    'HTTP 422: Validation Failed',
    'HTTP 403: Resource not accessible by integration',
    'HTTP 401: Bad credentials',
    'HTTP 404: Not Found',
    'release not found',
    'failed to run git: not a git repository',
  ]) {
    assert.ok(!isRetryableError(text), `${text} 不应该重试`)
  }
})

test('标签名补 v 前缀，缺产物按文件名和字节数比对', () => {
  assert.equal(toTag('0.28.1420'), 'v0.28.1420')
  assert.equal(toTag('v0.28.1420'), 'v0.28.1420')
  const expected = ASSETS.map((file) => ({ file, name: file.split('/').pop(), size: ASSET_SIZE }))
  const uploaded = ASSET_NAMES.map((name) => ({ name, size: ASSET_SIZE }))
  assert.deepEqual(missingAssets(expected, uploaded), [])
  assert.deepEqual(
    missingAssets(expected, uploaded.slice(0, 2)).map((a) => a.file),
    ASSETS.slice(2),
  )
  // 同名但大小不对（上次上传中途失败）也算缺
  const broken = [{ ...uploaded[0], size: 1 }, ...uploaded.slice(1)]
  assert.deepEqual(
    missingAssets(expected, broken).map((a) => a.file),
    [ASSETS[0]],
  )
})

test('同名资产大小不对时也补齐（上次只传了一半）', async () => {
  const gh = fakeGh({
    // 第一个资产名字在，但字节数不对
    view: () => ok(ASSET_NAMES.map((name, i) => `${name}\t${i === 0 ? 1 : ASSET_SIZE}`).join('\n')),
    upload: () => ok(),
  })
  const { result } = await publish(gh)

  assert.deepEqual(result.uploaded, [ASSET_NAMES[0]])
  assert.deepEqual(gh.calls.find((a) => a[1] === 'upload').slice(3, -1), [ASSETS[0]])
})

test('gh 被信号杀掉时不能当成发布成功', async () => {
  const gh = fakeGh({
    view: notFound,
    create: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
  })
  await assert.rejects(
    () => publish(gh),
    (e) => e.message.includes('SIGKILL') && e.message.includes('不重试'),
  )
  assert.equal(gh.count('create'), 1, '被信号杀掉不是可重试的瞬时错误')
})

test('workflow 的传参能解析成预期值', () => {
  const opts = parseArgs([
    '0.28.1420',
    '--target',
    'deadbeef',
    '--notes-file',
    'release/notes.md',
    '--asset',
    'release/agent-panel-0.28.1420.zip',
    '--asset',
    'release/SHA256SUMS',
  ])
  assert.deepEqual(opts, {
    version: '0.28.1420',
    target: 'deadbeef',
    notesFile: 'release/notes.md',
    assets: ['release/agent-panel-0.28.1420.zip', 'release/SHA256SUMS'],
  })
})

test('参数缺值、或把下一个 flag 当成值时直接报错', () => {
  assert.throws(() => parseArgs(['1.0.0', '--target']), /--target 缺少值/)
  assert.throws(() => parseArgs(['1.0.0', '--asset', '--target', 'abc']), /--asset 缺少值/)
})

test('没给产物时直接报错，不调用 gh', async () => {
  const gh = fakeGh({})
  await assert.rejects(() => publishRelease({ version: '0.28.1420', assets: [], exec: gh.exec }), /至少要给一个产物/)
  assert.equal(gh.calls.length, 0)
})

test('产物文件读不到时直接报错，不调用 gh', async () => {
  const gh = fakeGh({})
  await assert.rejects(
    () =>
      publishRelease({
        version: '0.28.1420',
        assets: ASSETS,
        exec: gh.exec,
        statSize: () => {
          throw new Error('ENOENT')
        },
      }),
    /产物文件不存在或读不到：release\/agent-panel-0\.28\.1420\.zip/,
  )
  assert.equal(gh.calls.length, 0, '本地文件读不到不该先去调 gh')
})
