import assert from 'node:assert/strict'
import { test } from 'node:test'
import { binaryProblem, hostOfUrl, isRemoteHostAllowed, normalizePublicUrl, tunnelUrl } from './remote.ts'
import { isLocalHost } from './hosts.ts'
import { Settings } from '../shared/schema.ts'

test('从 cloudflared 的输出里取临时地址', () => {
  const out = '2025-01-01T00:00:00Z INF |  https://funny-cats-jump.trycloudflare.com  |'
  assert.equal(tunnelUrl(out), 'https://funny-cats-jump.trycloudflare.com')
  assert.equal(tunnelUrl(out.toUpperCase().replace('HTTPS', 'https')), 'https://funny-cats-jump.trycloudflare.com')
  assert.equal(tunnelUrl('INF Requesting new quick Tunnel...'), '')
})

test('外部地址补协议、去掉路径', () => {
  assert.equal(normalizePublicUrl('panel.example.com'), 'https://panel.example.com')
  assert.equal(normalizePublicUrl('https://panel.example.com/abc?x=1'), 'https://panel.example.com')
  assert.equal(normalizePublicUrl(' http://127.0.0.1:8787 '), 'http://127.0.0.1:8787')
  assert.equal(normalizePublicUrl(''), '')
  assert.equal(normalizePublicUrl('ftp://panel.example.com'), '')
  assert.equal(normalizePublicUrl('https://'), '')
  assert.equal(hostOfUrl('https://Panel.Example.com/path'), 'panel.example.com')
  assert.equal(hostOfUrl('not a url'), '')
})

test('外部访问默认关闭，默认用临时地址', () => {
  const s = Settings.parse({})
  assert.equal(s.remoteAccess.enabled, false)
  assert.equal(s.remoteAccess.mode, 'quick')
  assert.equal(s.remoteAccess.tunnelToken, '')
  assert.equal(s.remoteAccess.publicUrl, '')
})

test('本机主机名', () => {
  for (const h of ['127.0.0.1:8787', 'localhost:5173', '[::1]:8787', '::1']) assert.equal(isLocalHost(h), true)
  for (const h of ['panel.example.com', '192.168.1.2:8787', 'evil.localhost.example.com'])
    assert.equal(isLocalHost(h), false)
})

test('没开外部访问时，外网地址不允许', () => {
  assert.equal(isRemoteHostAllowed('panel.example.com'), false)
})

test('frp：服务端只放行面板端口和映射范围，客户端只写合法的映射', async () => {
  const { frpcConfig, frpsConfig, deployScript, frpAsset, frpcEvent, frpcLine, frpcProxyOf } = await import('./frp.ts')
  const { frpVisitorConfig } = await import('../shared/remote.ts')
  const { FrpMapping } = await import('../shared/schema.ts')
  const map = (x: Record<string, unknown>) => FrpMapping.parse(x)
  const p2p = map({ id: 'p2p', type: 'xtcp', localPort: 22, remotePort: 20000, secretKey: 'k1', visitorPort: 6001 })
  const f = {
    ...Settings.parse({}).remoteAccess.frp,
    server: '47.100.1.2',
    token: 'abc123',
    mappings: [
      map({ id: 'ssh', name: 'SSH', localPort: 22, remotePort: 20022 }),
      map({ id: 'bad', localPort: 80, remotePort: 30000 }),
      map({ id: 'off', type: 'udp', localPort: 53, remotePort: 20053, enabled: false }),
      p2p,
      map({ id: 'fs', type: 'files', remotePort: 20080, localPath: '/srv/share', httpUser: 'u', httpPassword: 'pw' }),
      // 文件共享没有密码不写
      map({ id: 'nopw', type: 'files', remotePort: 20081, localPath: '/srv/share' }),
    ],
  }
  const s = frpsConfig(f)
  assert.match(s, /bindPort = 7000/)
  assert.match(s, /allowPorts = \[\{ single = 18787 \}, \{ start = 20000, end = 20099 \}\]/)
  const c = frpcConfig(f, 8788)
  assert.match(c, /serverAddr = "47.100.1.2"/)
  assert.match(c, /localPort = 8788\nremotePort = 18787/)
  assert.match(c, /name = "agent-panel-m-ssh"/)
  // 范围外的、停用的、缺密码的都不写
  assert.doesNotMatch(c, /agent-panel-m-bad|agent-panel-m-off|agent-panel-m-nopw/)
  // P2P：xtcp 加一条同密钥的 stcp 兜底，都不占服务器端口
  assert.match(c, /name = "agent-panel-m-p2p"\ntype = "xtcp"\nsecretKey = "k1"/)
  assert.match(c, /name = "agent-panel-m-p2p-stcp"\ntype = "stcp"/)
  assert.doesNotMatch(c, /remotePort = 20000/)
  // 文件共享：static_file 插件，带账号密码
  assert.match(c, /remotePort = 20080\ntransport.useEncryption = true\n\[proxies.plugin\]\ntype = "static_file"/)
  assert.match(c, /localPath = "\/srv\/share"\nhttpUser = "u"\nhttpPassword = "pw"/)
  const v = frpVisitorConfig(f, p2p)
  assert.match(v, /serverName = "agent-panel-m-p2p"/)
  assert.match(v, /bindPort = 6001/)
  assert.match(v, /fallbackTo = "agent-panel-m-p2p-visitor-stcp"/)
  assert.match(deployScript(f, '/tmp/x'), /systemctl restart agent-panel-frps/)
  assert.equal(frpAsset('linux', 'x86_64')?.name, 'frp_0.61.1_linux_amd64.tar.gz')
  assert.equal(frpAsset('win32', 'arm64')?.name, 'frp_0.61.1_windows_arm64.zip')
  assert.equal(frpAsset('linux', 'mips'), undefined)
  assert.equal(frpcEvent('[I] [agent-panel] start proxy success'), 'ok')
  assert.equal(frpcEvent('[W] login to the server failed: dial tcp 1.2.3.4:7000: i/o timeout'), 'unreachable')
  assert.equal(frpcEvent('[W] [agent-panel-m-ssh] start error: port not allowed'), 'port')
  assert.equal(frpcProxyOf('[W] [agent-panel-m-ssh] start error: port not allowed'), 'agent-panel-m-ssh')
  assert.equal(frpcProxyOf('[I] [agent-panel-m-p2p-stcp] start proxy success'), 'agent-panel-m-p2p')
  assert.equal(frpcProxyOf('[I] [abcd1234] [agent-panel] start proxy success'), 'agent-panel')
  assert.equal(
    frpcLine(
      '\x1b[1;33m2026-11-01 13:31:03.943 [W] [client/service.go:298] connect to server error: i/o timeout\x1b[0m',
    ),
    'connect to server error: i/o timeout',
  )
  assert.match(c, /log.disablePrintColor = true/)
})

test('frp：端口映射的校验', async () => {
  const { frpMappingError } = await import('../shared/remote.ts')
  const { FrpMapping } = await import('../shared/schema.ts')
  const f = Settings.parse({}).remoteAccess.frp
  const m = FrpMapping.parse({ id: 'a', localPort: 22, remotePort: 20022 })
  assert.equal(frpMappingError(m, { ...f, mappings: [m] }), '')
  assert.notEqual(frpMappingError({ ...m, remotePort: 19999 }, f), '')
  const twin = { ...m, id: 'b' }
  assert.notEqual(frpMappingError(m, { ...f, mappings: [m, twin] }), '')
  // 同一端口 tcp 和 udp 可以各开一条
  assert.equal(frpMappingError(m, { ...f, mappings: [m, { ...twin, type: 'udp' }] }), '')
  // P2P 不看服务器端口，只要密钥
  assert.equal(frpMappingError({ ...m, type: 'xtcp', remotePort: 1, secretKey: 'k' }, f), '')
  assert.notEqual(frpMappingError({ ...m, type: 'xtcp', secretKey: '' }, f), '')
})

test('下载的 cloudflared 要是完整大小、本系统格式的可执行文件', () => {
  const big = 40 * 1024 * 1024
  const hex = (h: string) => Buffer.from(h, 'hex')
  assert.equal(binaryProblem(hex('7f454c46'), big, 'linux'), '')
  assert.equal(binaryProblem(Buffer.from('MZ\x90\x00', 'latin1'), big, 'win32'), '')
  assert.equal(binaryProblem(hex('cffaedfe'), big, 'darwin'), '')
  assert.equal(binaryProblem(hex('cafebabe'), big, 'darwin'), '', '通用二进制')
  // 被门户页换成 HTML、格式和系统对不上、太小的都拒绝
  assert.notEqual(binaryProblem(Buffer.from('<!DO'), big, 'linux'), '')
  assert.notEqual(binaryProblem(hex('7f454c46'), big, 'win32'), '')
  assert.notEqual(binaryProblem(hex('7f454c46'), 1000, 'linux'), '')
})
