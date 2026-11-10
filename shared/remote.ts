import type { FrpMapping, RemoteAccess, RemoteFrp } from './schema.ts'
import { t } from './i18n.ts'

export type RemoteMode = RemoteAccess['mode']

/** 外部访问当前的状态：off 没开，starting 正在连（frpc），running 可用，error 出错 */
export type RemoteState = 'off' | 'starting' | 'running' | 'error'

/** 设置页「外部访问」显示的状态 */
export interface RemoteAccessStatus {
  enabled: boolean
  mode: RemoteMode
  state: RemoteState
  /** 外网访问地址 */
  url: string
  /** 出错原因 */
  error: string
  /** 外网专用端口，0 表示没在监听；反向代理要转到这里 */
  localPort: number
  /** 外网专用端口是不是自己做了 HTTPS（直接监听时配了证书） */
  https: boolean
  /** 本机的局域网 IPv4：直接监听时拼访问地址、反代跑在 Docker 里时当转发目标 */
  lanIps: string[]
  /** 设置好访问密码了没有（打开外部访问时自动生成一个） */
  hasPassword: boolean
  /** 本机登录用户名：拼 SSH 连接命令用 */
  localUser: string
  /** Tailscale 的检测结果（只在 Tailscale 方式下检测） */
  tailscale: TailscaleInfo | null
  /** Tailscale 等你去后台开启 Serve / Funnel 的链接（tailscale 自己给的）；开好后自动连上，没在等时为空 */
  enableUrl: string
  /** 正在下载 frpc；percent 为 -1 时不知道总大小 */
  download: { running: boolean; percent: number; error: string } | null
  /** 一键配置云服务器的进度 */
  deploy: FrpDeployStatus | null
  /** 各条端口映射的状态（按映射 id）：ok 已在服务器上开好，error 是 frpc 报的原因 */
  mappings: Record<string, { ok: boolean; error: string }>
}

export interface TailscaleInfo {
  installed: boolean
  version: string
  path: string
  /** 登录了、连着 tailnet */
  running: boolean
  /** 这台机器在 tailnet 里的域名（<机器名>.<tailnet>.ts.net） */
  dnsName: string
  /** 没装、没登录的原因 */
  error: string
}

/** 一个登录着的外网设备 */
export interface GuardSession {
  id: string
  ip: string
  ua: string
  createdAt: number
  lastSeen: number
}

/** 设置页「访问密码」「登录的设备」用的状态 */
export interface GuardState {
  hasPassword: boolean
  /** 自动生成、还没改过的初始密码：只在本机打开设置页时给出，外网为空 */
  initialPassword: string
  /** 这次请求是不是从外网来的（外网改密码要先验证当前密码） */
  external: boolean
  /** 当前浏览器的会话 id（本机打开时为空） */
  current: string
  sessions: GuardSession[]
}

/** 设置页给出配置示例的反向代理 */
export type ProxyKind = 'caddy' | 'npm' | 'nginx'

/** 示例里用的域名：设置里填了访问地址就用它，没填用占位 */
export function proxyHost(publicUrl: string) {
  try {
    const s = publicUrl.trim()
    if (s) return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname
  } catch {}
  return 'panel.example.com'
}

/**
 * 反向代理的配置示例。upstream 是反代连面板用的地址：本机反代是 127.0.0.1:外网专用端口，
 * 反代跑在 Docker 里是本机局域网 IP:端口，frp 方式下是云服务器上的 127.0.0.1:面板端口（反代装在云服务器上）。
 * 要点：Host 原样转发、带上 X-Forwarded-*（登录来源检查和失败锁定要用）、不缓冲（任务进度走 SSE 长连接）、
 * 上传上限放大（导入数据、上传图片和视频）
 */
export function proxySnippet(kind: ProxyKind, publicUrl: string, upstream: string) {
  const host = proxyHost(publicUrl)
  const plainHttp = /^http:\/\//i.test(publicUrl.trim())
  if (kind === 'caddy')
    return [
      `${plainHttp ? 'http://' : ''}${host} {`,
      `\treverse_proxy ${upstream} {`,
      // 收到就转发，不等缓冲攒满：任务进度是 SSE；Caddy 默认就转 Host 和 X-Forwarded-*
      '\t\tflush_interval -1',
      '\t}',
      '\trequest_body {',
      '\t\tmax_size 2GB',
      '\t}',
      '}',
      '',
    ].join('\n')
  // Nginx Proxy Manager 的「Advanced → Custom Nginx Configuration」：转发目标、Host、证书在界面里填，这里只补缓冲和上限
  if (kind === 'npm')
    return ['proxy_buffering off;', 'proxy_read_timeout 1d;', 'client_max_body_size 2g;', ''].join('\n')
  return [
    'server {',
    `    listen ${plainHttp ? '80' : '443 ssl'};`,
    `    server_name ${host};`,
    ...(plainHttp
      ? []
      : [
          `    ssl_certificate     /etc/letsencrypt/live/${host}/fullchain.pem;`,
          `    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;`,
        ]),
    '    client_max_body_size 2g;',
    '',
    '    location / {',
    `        proxy_pass http://${upstream};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $http_connection;',
    '        proxy_buffering off;',
    '        proxy_read_timeout 1d;',
    '    }',
    '}',
    '',
  ].join('\n')
}

/** 端口映射哪里不对：服务器端口要在一键配置时放行的范围里，不能和面板端口、别的映射重复；没问题返回空 */
export function frpMappingError(
  m: FrpMapping,
  f: Pick<RemoteFrp, 'bindPort' | 'remotePort' | 'rangeStart' | 'rangeEnd' | 'mappings'>,
): string {
  if (m.type === 'xtcp') {
    // P2P 不占服务器端口，只要有密钥
    if (!m.secretKey) return t('缺少 P2P 密钥：删掉这条重新添加')
    return ''
  }
  if (m.type === 'files') {
    if (!m.localPath) return t('请选择要共享的目录')
    if (!m.httpUser || !m.httpPassword) return t('文件共享要设置用户名和密码')
  }
  if (m.remotePort < f.rangeStart || m.remotePort > f.rangeEnd)
    return t('服务器端口要在 {start}–{end} 之间', { start: String(f.rangeStart), end: String(f.rangeEnd) })
  if (m.remotePort === f.remotePort || m.remotePort === f.bindPort) return t('服务器端口和面板或 frp 端口重复')
  // 同一个端口 tcp、udp 可以各开一条；文件共享占的是 tcp
  const proto = (x: FrpMapping) => (x.type === 'udp' ? 'udp' : 'tcp')
  if (
    f.mappings.some(
      (o) => o.id !== m.id && o.enabled && o.type !== 'xtcp' && o.remotePort === m.remotePort && proto(o) === proto(m),
    )
  )
    return t('服务器端口和另一条映射重复')
  return ''
}

/** frpc 里映射的代理名：按映射的 id，日志里据此认出是哪一条；xtcp 另有一条同密钥的 stcp 兜底 */
export const mappingProxyName = (id: string) => `agent-panel-m-${id}`

/** TOML 字符串：JSON 的转义规则和 TOML 基本字符串兼容 */
export const tomlString = (s: string) => JSON.stringify(s)

/**
 * P2P（xtcp）访问端的 frpc 配置：在另一台电脑上运行，连 127.0.0.1:visitorPort 就到了这台电脑的服务。
 * 先尝试直连（打洞），1 秒内打不通就退回经服务器中转的 stcp。里面带 frp 令牌，只给自己的电脑用
 */
export function frpVisitorConfig(f: Pick<RemoteFrp, 'server' | 'bindPort' | 'token'>, m: FrpMapping) {
  const name = mappingProxyName(m.id)
  return [
    `serverAddr = ${tomlString(f.server)}`,
    `serverPort = ${f.bindPort}`,
    'auth.method = "token"',
    `auth.token = ${tomlString(f.token)}`,
    'loginFailExit = false',
    '',
    '[[visitors]]',
    `name = ${tomlString(`${name}-visitor-stcp`)}`,
    'type = "stcp"',
    `serverName = ${tomlString(`${name}-stcp`)}`,
    `secretKey = ${tomlString(m.secretKey)}`,
    'bindAddr = "127.0.0.1"',
    // -1：不单独监听，只作为下面 xtcp 打洞失败时的退路
    'bindPort = -1',
    '',
    '[[visitors]]',
    `name = ${tomlString(`${name}-visitor`)}`,
    'type = "xtcp"',
    `serverName = ${tomlString(name)}`,
    `secretKey = ${tomlString(m.secretKey)}`,
    'bindAddr = "127.0.0.1"',
    `bindPort = ${m.visitorPort}`,
    'keepTunnelOpen = true',
    `fallbackTo = ${tomlString(`${name}-visitor-stcp`)}`,
    'fallbackTimeoutMs = 1000',
    '',
  ].join('\n')
}

/** 一键配置云服务器走到哪一步：登录、下载 frps、上传、安装、完成 */
export interface FrpDeployStatus {
  running: boolean
  step: 'connect' | 'download' | 'upload' | 'install' | 'done'
  /** 下载进度，-1 表示不知道 */
  percent: number
  error: string
}

/** frp 连接测试的一步：ok 为 null 表示前面断了、这一步没测 */
export interface FrpTestStep {
  id: 'config' | 'local' | 'server' | 'frpc' | 'panel'
  title: string
  ok: boolean | null
  /** 这一步用了多久（毫秒），没测为 0 */
  ms: number
  /** 通过时的说明，或没通过时该去查什么 */
  detail: string
}
