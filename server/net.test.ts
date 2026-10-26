import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang, t } from '../shared/i18n.ts'
import type { NetDeps, ProxyPlan } from './net.ts'
import { DEFAULT_PROXY_PORT, DEFAULT_PROXY_URL, LOCAL_PROXY_PORTS, MAX_LOCAL_PROXIES } from '../shared/proxy.ts'

// 设置模块会读数据目录，用临时的别碰本机
const data = await mkdtemp(path.join(tmpdir(), 'agent-panel-net-data-'))
process.env.AGENT_PANEL_DATA = data
const {
  attemptOrder,
  configuredProxy,
  isLocalUrl,
  localProxyCandidates,
  markProxyBad,
  netFetchWith,
  noProxy,
  parseScutilProxy,
  parseWindowsProxy,
  pickLocalProxies,
  planFor,
  probeProxy,
  windowsProxy,
} = await import('./net.ts')
// 断言的是中文原文，CI 的系统语言是英文，导入之后再固定
setLang('zh')

const RELEASE_URL = 'https://api.github.com/repos/fixcode-h/agent-panel/releases'
const PROXY = 'http://127.0.0.1:7890'

function fetchFailed(code = 'UND_ERR_CONNECT_TIMEOUT') {
  const err = new TypeError('fetch failed') as TypeError & { cause?: { code?: string } }
  err.cause = { code }
  return err
}

const ok = () => new Response('ok')

interface StubOptions {
  plan: ProxyPlan
  direct?: (url: string, init: RequestInit) => Promise<Response>
  viaProxy?: (url: string, init: RequestInit, key: string) => Promise<Response>
  discover?: () => Promise<string[]>
  proxyFailed?: (key: string) => void
}

/** 记录每条路走了几次；默认直连和代理都成功 */
function stub(o: StubOptions) {
  const calls: string[] = []
  const failed: string[] = []
  const deps: NetDeps = {
    plan: async () => o.plan,
    direct: async (url, init) => {
      calls.push('direct')
      return o.direct ? o.direct(url, init) : ok()
    },
    viaProxy: async (url, init, key) => {
      calls.push(key)
      return o.viaProxy ? o.viaProxy(url, init, key) : ok()
    },
    discover: o.discover ?? (async () => []),
    proxyFailed: (key) => {
      failed.push(key)
      o.proxyFailed?.(key)
    },
  }
  return { deps, calls, failed }
}

const directPlan: ProxyPlan = { kind: 'direct', fallback: true }
const configuredPlan: ProxyPlan = { kind: 'proxy', key: PROXY, shown: PROXY }

test('Windows 系统代理：开关关闭时不算，https 优先于 http，socks 不能用', () => {
  assert.deepEqual(windowsProxy('0x1', '127.0.0.1:7890'), ['http://127.0.0.1:7890'])
  assert.deepEqual(windowsProxy('1', '127.0.0.1:7890'), ['http://127.0.0.1:7890'])
  assert.deepEqual(windowsProxy('0x0', '127.0.0.1:7890'), [])
  assert.deepEqual(windowsProxy('0x1', ''), [])
  assert.deepEqual(windowsProxy('0x1', 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080'), [
    'http://127.0.0.1:7891',
    'http://127.0.0.1:7890',
  ])
})

test('解析 reg query 的输出', () => {
  const text = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:7890',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWindowsProxy(text), ['http://127.0.0.1:7890'])
  assert.deepEqual(parseWindowsProxy(text.replace('0x1', '0x0')), [])
})

test('解析 macOS scutil --proxy 的输出', () => {
  const text = [
    '<dictionary> {',
    '  ExceptionsList : <array> {',
    '    0 : *.local',
    '  }',
    '  HTTPEnable : 1',
    '  HTTPPort : 7890',
    '  HTTPProxy : 127.0.0.1',
    '  HTTPSEnable : 1',
    '  HTTPSPort : 7891',
    '  HTTPSProxy : 127.0.0.1',
    '  SOCKSEnable : 1',
    '  SOCKSPort : 1080',
    '  SOCKSProxy : 127.0.0.1',
    '}',
  ].join('\n')
  assert.deepEqual(parseScutilProxy(text), ['http://127.0.0.1:7891', 'http://127.0.0.1:7890'])
  // 只开 HTTP 时用 HTTP
  assert.deepEqual(parseScutilProxy(text.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), ['http://127.0.0.1:7890'])
})

test('探测候选：系统代理在前，本地端口全部列出（v2rayN 的默认端口、老版的 10809 都在）', () => {
  assert.deepEqual(localProxyCandidates(['http://127.0.0.1:8080'], [7890, DEFAULT_PROXY_PORT, 10809, 7891]), [
    'http://127.0.0.1:8080',
    'http://127.0.0.1:7890',
    DEFAULT_PROXY_URL,
    'http://127.0.0.1:10809',
    'http://127.0.0.1:7891',
  ])
  // 和系统代理重复的端口不再列一次
  assert.deepEqual(localProxyCandidates(['http://127.0.0.1:7890'], [7890, 7891]), [
    'http://127.0.0.1:7890',
    'http://127.0.0.1:7891',
  ])
  assert.deepEqual(localProxyCandidates([], []), [])
})

test('真正尝试的代理：系统代理全留，本地端口最多 3 个，默认端口不会被 Clash 挤掉', () => {
  const alive = ['http://127.0.0.1:7890', DEFAULT_PROXY_URL, 'http://127.0.0.1:10809', 'http://127.0.0.1:7891']
  assert.deepEqual(pickLocalProxies([], alive), alive.slice(0, MAX_LOCAL_PROXIES))
  assert.equal(pickLocalProxies([], alive)[1], DEFAULT_PROXY_URL)
  // 系统代理全部保留，不算进本地端口的 3 个里面
  assert.deepEqual(pickLocalProxies(['http://127.0.0.1:8080'], ['http://127.0.0.1:8080', ...alive]), [
    'http://127.0.0.1:8080',
    ...alive.slice(0, MAX_LOCAL_PROXIES),
  ])
  // 探测失败（不在可用列表里）的系统代理不保留
  assert.deepEqual(pickLocalProxies(['http://127.0.0.1:8080'], alive), alive.slice(0, MAX_LOCAL_PROXIES))
  assert.deepEqual(pickLocalProxies([], []), [])
})

// 用户机器上只跑 v2rayN 这类「默认入站一个端口」的代理软件：它必须在默认顺序的前几个里，
// 否则会被 MAX_LOCAL_PROXIES 截掉，自动探测永远轮不到它（顺序本身由 shared/proxy.test.ts 钉住）
test('只开了默认端口的机器也能探测到并使用', () => {
  const candidates = localProxyCandidates([], LOCAL_PROXY_PORTS)
  assert.ok(candidates.includes(DEFAULT_PROXY_URL), '默认端口要在探测候选里')
  assert.deepEqual(pickLocalProxies([], [DEFAULT_PROXY_URL]), [DEFAULT_PROXY_URL])
})

test('尝试顺序：配置的代理 → 本机代理 → 直连，空字符串表示直连', () => {
  assert.deepEqual(attemptOrder(undefined, [PROXY]), ['', PROXY])
  assert.deepEqual(attemptOrder(PROXY, ['http://127.0.0.1:10809']), [PROXY, 'http://127.0.0.1:10809', ''])
  // 配置的代理也出现在探测结果里时只试一次
  assert.deepEqual(attemptOrder(PROXY, [PROXY]), [PROXY, ''])
})

test('本机地址识别', () => {
  assert.ok(isLocalUrl('http://127.0.0.1:8787/api/health'))
  assert.ok(isLocalUrl('http://localhost:5173/'))
  assert.ok(isLocalUrl('http://[::1]:8787/'))
  assert.ok(!isLocalUrl(RELEASE_URL))
  assert.ok(!isLocalUrl('not a url'))
})

test('一开始走哪条路：设置优先，没写协议补 http://，socks 照原样交给回退', () => {
  assert.deepEqual(planFor(RELEASE_URL, '127.0.0.1:7890', '', ''), {
    kind: 'proxy',
    key: 'http://127.0.0.1:7890',
    shown: 'http://127.0.0.1:7890',
  })
  assert.deepEqual(planFor(RELEASE_URL, 'http://127.0.0.1:7890', 'http://127.0.0.1:10809', ''), {
    kind: 'proxy',
    key: 'http://127.0.0.1:7890',
    shown: 'http://127.0.0.1:7890',
  })
  assert.deepEqual(planFor(RELEASE_URL, 'socks5://127.0.0.1:1080', '', ''), {
    kind: 'proxy',
    key: 'socks5://127.0.0.1:1080',
    shown: 'socks5://127.0.0.1:1080',
  })
  // 设置里没填：环境变量代理，NO_PROXY 命中时直连
  assert.deepEqual(planFor(RELEASE_URL, '', 'http://127.0.0.1:7890', ''), {
    kind: 'proxy',
    key: 'http://127.0.0.1:7890',
    shown: 'http://127.0.0.1:7890',
  })
  assert.deepEqual(planFor(RELEASE_URL, '', 'http://127.0.0.1:7890', 'github.com'), {
    kind: 'direct',
    fallback: false,
  })
  // 本机地址永远直连，设置里填了代理也不走
  assert.deepEqual(planFor('http://127.0.0.1:8787/api/health', 'http://127.0.0.1:7890', '', ''), {
    kind: 'direct',
    fallback: false,
  })
  // 什么代理都没有：直连，失败后可以回退
  assert.deepEqual(planFor(RELEASE_URL, '', '', ''), { kind: 'direct', fallback: true })
})

test('启用代理的开关：关着时不用设置里的地址，环境变量和自动探测照旧', () => {
  // 开着：用设置里的地址，前后空格去掉
  assert.equal(configuredProxy({ proxy: ' 127.0.0.1:7890 ', networkProxyEnabled: true }), '127.0.0.1:7890')
  // 关着：按没填处理，后面的回退逻辑（环境变量、本机探测、直连）照旧
  assert.equal(configuredProxy({ proxy: '127.0.0.1:7890', networkProxyEnabled: false }), '')
  // 开关关掉、地址留空的组合也不需要特判
  assert.equal(configuredProxy({ proxy: '', networkProxyEnabled: false }), '')
  // 关掉之后，真的算出来的是「环境变量 → 直连」，不会再看设置里的地址
  const set = configuredProxy({ proxy: 'http://127.0.0.1:7890', networkProxyEnabled: false })
  assert.deepEqual(planFor(RELEASE_URL, set, 'http://127.0.0.1:10809', ''), {
    kind: 'proxy',
    key: 'http://127.0.0.1:10809',
    shown: 'http://127.0.0.1:10809',
  })
  assert.deepEqual(planFor(RELEASE_URL, set, '', ''), { kind: 'direct', fallback: true })
})

test('NO_PROXY 的写法：域名后缀、通配、端口和前缀点', () => {
  assert.ok(noProxy(RELEASE_URL, 'github.com'))
  assert.ok(noProxy(RELEASE_URL, '.github.com,example.com'))
  assert.ok(noProxy(RELEASE_URL, '*'))
  assert.ok(noProxy('http://example.com:8080/', 'example.com:443'))
  assert.ok(!noProxy(RELEASE_URL, 'example.com'))
  assert.ok(!noProxy('https://notgithub.com/', 'github.com'))
})

test('代理失败后从缓存里去掉，全部失败时换成较短的重新探测间隔', () => {
  const cache = { at: 0, list: ['http://127.0.0.1:7890', 'http://127.0.0.1:10809'], ttl: 60_000 }
  const next = markProxyBad('http://127.0.0.1:7890', cache)
  assert.deepEqual(next?.list, ['http://127.0.0.1:10809'])
  assert.equal(next?.ttl, 60_000)
  assert.deepEqual(cache.list, ['http://127.0.0.1:7890', 'http://127.0.0.1:10809'], '不改传进来的缓存')
  const empty = markProxyBad('http://127.0.0.1:7890', { ...cache, list: ['http://127.0.0.1:7890'] })
  assert.deepEqual(empty?.list, [])
  assert.ok(empty && empty.ttl > 0 && empty.ttl < cache.ttl, '全都不行了就按「没找到」的短间隔重新探测')
  // 没有探测过时什么都不做
  assert.equal(markProxyBad('http://127.0.0.1:7890', undefined), undefined)
})

test('直连失败、本机有代理：自动改用代理重试一次', async () => {
  const { deps, calls } = stub({
    plan: directPlan,
    direct: async () => {
      throw fetchFailed()
    },
    discover: async () => [PROXY],
  })
  const res = await netFetchWith(deps, RELEASE_URL)
  assert.equal(await res.text(), 'ok')
  assert.deepEqual(calls, ['direct', PROXY])
})

test('直连失败、本机没有代理：保持直连失败，并说明没有发现运行中的代理', async () => {
  const { deps, calls } = stub({
    plan: directPlan,
    direct: async () => {
      throw fetchFailed()
    },
    discover: async () => [],
  })
  await assert.rejects(netFetchWith(deps, RELEASE_URL), (e: Error) => {
    assert.match(e.message, /UND_ERR_CONNECT_TIMEOUT/)
    assert.ok(e.message.includes(t('没有发现运行中的本机代理。')), e.message)
    assert.ok(e.message.includes(t('访问不了 GitHub 时，可以在「设置 · 网络与代理」里填写本机代理。')), e.message)
    return true
  })
  assert.deepEqual(calls, ['direct'])
})

test('配置的代理优先：失败后再试本机代理，不会直接跳到直连', async () => {
  const local = 'http://127.0.0.1:10809'
  const { deps, calls } = stub({
    plan: configuredPlan,
    viaProxy: async (_url, _init, key) => {
      if (key === local) return ok()
      throw fetchFailed('ECONNREFUSED')
    },
    discover: async () => [local],
  })
  await netFetchWith(deps, RELEASE_URL)
  assert.deepEqual(calls, [PROXY, local])
})

test('配置的代理和本机代理都失败时最后试直连', async () => {
  const local = 'http://127.0.0.1:10809'
  const { deps, calls, failed } = stub({
    plan: configuredPlan,
    viaProxy: async () => {
      throw fetchFailed('ECONNREFUSED')
    },
    discover: async () => [local],
  })
  await netFetchWith(deps, RELEASE_URL)
  assert.deepEqual(calls, [PROXY, local, 'direct'])
  // 失败的代理从探测结果里去掉，下次重新确认
  assert.deepEqual(failed, [local])
})

test('所有路径都失败：错误里列出试过的每条路，并说明没有找到本机代理', async () => {
  const { deps } = stub({
    plan: configuredPlan,
    direct: async () => {
      throw fetchFailed()
    },
    viaProxy: async () => {
      throw fetchFailed('ECONNREFUSED')
    },
    discover: async () => [],
  })
  await assert.rejects(netFetchWith(deps, RELEASE_URL), (e: Error) => {
    assert.ok(
      e.message.includes(
        t('尝试过的路径：{paths}。', { paths: `${t('代理 {proxy}', { proxy: PROXY })}、${t('直连')}` }),
      ),
      e.message,
    )
    assert.ok(e.message.includes(t('没有发现运行中的本机代理。')), e.message)
    return true
  })
})

test('本机地址不走代理，失败了也不去探测', async () => {
  let discovered = 0
  const { deps, calls } = stub({
    plan: { kind: 'direct', fallback: false },
    direct: async () => {
      throw fetchFailed('ECONNREFUSED')
    },
    discover: async () => {
      discovered++
      return [PROXY]
    },
  })
  await assert.rejects(netFetchWith(deps, 'http://127.0.0.1:8787/api/health'))
  assert.deepEqual(calls, ['direct'])
  assert.equal(discovered, 0)
})

test('用户取消：不换路径、不探测', async () => {
  const ac = new AbortController()
  let discovered = 0
  const { deps, calls } = stub({
    plan: directPlan,
    direct: async () => {
      ac.abort()
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    },
    discover: async () => {
      discovered++
      return [PROXY]
    },
  })
  await assert.rejects(netFetchWith(deps, RELEASE_URL, { signal: ac.signal }))
  assert.deepEqual(calls, ['direct'])
  assert.equal(discovered, 0)
})

test('调用方自己的 signal 已经中止（取消或总预算用完）：停止，不再探测代理', async () => {
  // comfy-templates 这类调用方用 AbortSignal.timeout 自己限时，已经用完的预算不能再拿来重试
  const ac = new AbortController()
  ac.abort(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
  let discovered = 0
  const { deps, calls } = stub({
    plan: directPlan,
    direct: async () => {
      throw fetchFailed()
    },
    discover: async () => {
      discovered++
      return [PROXY]
    },
  })
  await assert.rejects(netFetchWith(deps, RELEASE_URL, { signal: ac.signal }))
  assert.deepEqual(calls, ['direct'])
  assert.equal(discovered, 0)
})

test('最后一条是本机代理时，错误里仍然保留设置页的提示', async () => {
  const { deps } = stub({
    plan: directPlan,
    direct: async () => {
      throw fetchFailed()
    },
    viaProxy: async () => {
      throw fetchFailed('ECONNREFUSED')
    },
    discover: async () => [PROXY],
  })
  await assert.rejects(netFetchWith(deps, RELEASE_URL), (e: Error) => {
    assert.ok(e.message.includes(t('访问不了 GitHub 时，可以在「设置 · 网络与代理」里填写本机代理。')), e.message)
    assert.ok(
      e.message.includes(
        t('尝试过的路径：{paths}。', {
          paths: `${t('直连')}、${t('本机代理 {proxy}', { proxy: PROXY })}`,
        }),
      ),
      e.message,
    )
    return true
  })
})

test('每次尝试的超时单独计时：直连超时后还能用代理重试', async () => {
  const { deps, calls } = stub({
    plan: directPlan,
    direct: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    discover: async () => [PROXY],
  })
  const res = await netFetchWith(deps, RELEASE_URL, { timeoutMs: 20 })
  assert.equal(await res.text(), 'ok')
  assert.deepEqual(calls, ['direct', PROXY])
})

test('每次尝试前通知调用方，便于重置空闲计时', async () => {
  let attempts = 0
  const { deps } = stub({
    plan: directPlan,
    direct: async () => {
      throw fetchFailed()
    },
    discover: async () => [PROXY],
  })
  const res = await netFetchWith(deps, RELEASE_URL, { onAttempt: () => attempts++ })
  assert.equal(await res.text(), 'ok')
  // 直连一次、回退到代理一次
  assert.equal(attempts, 2)
})

/** 起一个只处理 CONNECT 的代理，用来验证握手探测 */
async function connectProxy(reply: boolean) {
  const server = createServer()
  server.on('connect', (_req, socket) => {
    if (reply) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

test('代理探测：能转发的算可用，不握手的不算', async () => {
  const good = await connectProxy(true)
  const silent = await connectProxy(false)
  try {
    assert.equal(await probeProxy(good.url, 500), true)
    assert.equal(await probeProxy(silent.url, 150), false)
    // 端口没人监听
    const closed = await connectProxy(true)
    await closed.close()
    assert.equal(await probeProxy(closed.url, 150), false)
  } finally {
    await good.close()
    await silent.close()
  }
})

test('收尾：删掉测试用的数据目录', async () => {
  await rm(data, { recursive: true, force: true })
})
