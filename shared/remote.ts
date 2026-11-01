import type { FrpMapping, RemoteAccess, RemoteFrp } from './schema.ts'
import { t } from './i18n.ts'

export type RemoteMode = RemoteAccess['mode']

/** 隧道当前的状态：off 没开，starting 正在连，running 可用，error 出错 */
export type RemoteState = 'off' | 'starting' | 'running' | 'error'

export interface CloudflaredInfo {
  installed: boolean
  version: string
  path: string
  /** 没找到或检测失败的原因 */
  error: string
}

/** 设置页「外部访问」显示的状态 */
export interface RemoteAccessStatus {
  enabled: boolean
  mode: RemoteMode
  state: RemoteState
  /** 外网访问地址（不带令牌） */
  url: string
  /** 带访问令牌的地址，外网的浏览器用它打开一次 */
  link: string
  /** 出错原因 */
  error: string
  /** 外网专用端口（只监听 127.0.0.1），0 表示没在监听；自建反代要转到这里 */
  localPort: number
  /** 本机登录用户名：拼 SSH 连接命令用 */
  localUser: string
  cloudflared: CloudflaredInfo
  /** 正在下载 cloudflared；percent 为 -1 时不知道总大小 */
  download: { running: boolean; percent: number; error: string } | null
  /** 一键配置云服务器的进度 */
  deploy: FrpDeployStatus | null
  /** 各条端口映射的状态（按映射 id）：ok 已在服务器上开好，error 是 frpc 报的原因 */
  mappings: Record<string, { ok: boolean; error: string }>
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
