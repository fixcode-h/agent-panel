import { z } from 'zod'

/** 设置「外部访问」的结构：从 schema.ts 拆出来，由它转出 */

/**
 * frp 的一条映射。type：
 * - tcp / udp：云服务器的 remotePort → 本机（或局域网）localIP:localPort
 * - xtcp：P2P 直连，不占服务器端口；另一台电脑用「访问端配置」跑 frpc 连过来，打洞失败时经服务器中转（stcp）
 * - files：把本机一个目录做成网页文件共享（frp 的 static_file 插件），用 remotePort 访问，带用户名密码
 */
export const FrpMapping = z.object({
  id: z.string().regex(/^[a-z0-9]{1,16}$/),
  name: z.string().trim().max(40).default(''),
  type: z.enum(['tcp', 'udp', 'xtcp', 'files']).catch('tcp').default('tcp'),
  localIP: z.string().trim().max(255).default('127.0.0.1'),
  localPort: z.number().int().min(1).max(65535).catch(22).default(22),
  remotePort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
  /** xtcp：访问端和本机共用的密钥（新建时生成，只存在本机） */
  secretKey: z.string().trim().max(200).default(''),
  /** xtcp：访问端那台电脑上监听的本机端口，连 127.0.0.1:visitorPort 就到了这里 */
  visitorPort: z.number().int().min(1).max(65535).catch(6000).default(6000),
  /** files：共享的目录（绝对路径，~ 开头按用户目录展开） */
  localPath: z.string().trim().max(1000).default(''),
  /** files：打开共享时要输的用户名和密码（新建时生成，只存在本机） */
  httpUser: z.string().trim().max(64).default(''),
  httpPassword: z.string().max(200).default(''),
})
export type FrpMapping = z.infer<typeof FrpMapping>

/** 「云服务器（frp）」：面板经 SSH 在云服务器上装好 frps，本机跑 frpc 把外网端口转进来 */
export const RemoteFrp = z.object({
  /** 云服务器的公网 IP 或域名 */
  server: z.string().trim().max(255).default(''),
  /** SSH 端口；密码只在一键配置时用一次，不保存 */
  sshPort: z.number().int().min(1).max(65535).catch(22).default(22),
  sshUser: z.string().trim().max(64).default('root'),
  /** frps 和 frpc 之间的连接端口 */
  bindPort: z.number().int().min(1).max(65535).catch(7000).default(7000),
  /** 外网访问面板用的端口：http://<server>:<remotePort> */
  remotePort: z.number().int().min(1).max(65535).catch(18787).default(18787),
  /** frpc 连 frps 的认证令牌：一键配置时生成，只存在本机数据目录 */
  token: z.string().trim().max(200).default(''),
  /**
   * 端口映射可用的服务器端口范围：一键配置时写进 frps 的 allowPorts，
   * 之后增删映射只改本机 frpc，不用再登录服务器
   */
  rangeStart: z.number().int().min(1).max(65535).catch(20000).default(20000),
  rangeEnd: z.number().int().min(1).max(65535).catch(20099).default(20099),
  /** 端口映射：把本机（或局域网里）的 SSH、远程桌面等服务通过云服务器开到外网 */
  mappings: z.array(FrpMapping).max(50).catch([]).default([]),
})
export type RemoteFrp = z.infer<typeof RemoteFrp>

/** Tailscale 方式：tailscale serve（只有自己 tailnet 里的设备能打开）或 funnel（开到公网） */
export const RemoteTailscale = z.object({
  /** 打开后用 funnel 开到公网，任何人拿到地址都能打开登录页；关着只有自己登录了 Tailscale 的设备能访问 */
  funnel: z.boolean().default(false),
  /** 对外的 https 端口：funnel 只允许 443、8443、10000 */
  httpsPort: z
    .union([z.literal(443), z.literal(8443), z.literal(10000)])
    .catch(443)
    .default(443),
  /** tailscale 可执行文件；留空自动找 */
  command: z.string().trim().max(500).default(''),
})
export type RemoteTailscale = z.infer<typeof RemoteTailscale>

/**
 * 外部访问 = 一个带密码登录的外网专用端口（登录门参考 dsh-web-guard 的做法，见 server/guard/），外网连过来的路有三种：
 * - frp：一键配置的云服务器，本机没有公网 IP 时用；
 * - tailscale：用户装好的 Tailscale，serve 给自己的设备或 funnel 开到公网，不要公网 IP 也不要服务器；
 * - custom：自己的反向代理（Caddy、Nginx Proxy Manager、nginx）或直接监听局域网 / 公网。
 * 以前的 Cloudflare 隧道（quick、token）已经去掉：老设置里的 quick / token 读进来按 frp 处理，tunnelToken、command 丢掉
 */
export const RemoteAccess = z.object({
  enabled: z.boolean().default(false),
  mode: z
    .preprocess((v) => (v === 'quick' || v === 'token' ? 'frp' : v), z.enum(['frp', 'tailscale', 'custom']))
    .catch('frp')
    .default('frp'),
  /** 浏览器里打开的地址（反代的域名、frp 云服务器上 Caddy 的域名，或直连时的 IP:端口）：登录的来源检查和配置示例用 */
  publicUrl: z.string().trim().max(300).default(''),
  /**
   * 外网请求专用的本机端口：frpc、反向代理都转到这里。
   * 从这个端口进来的请求一律当外网处理（必须有密码登录的会话），不靠 Host 头判断——
   * 反向代理把 Host 改成 127.0.0.1 时，按 Host 判断会把外网请求当成本机
   */
  localPort: z.number().int().min(1).max(65535).catch(8788).default(8788),
  /**
   * custom 方式下外网专用端口监听在哪：127.0.0.1 只给本机的反向代理；0.0.0.0 局域网、公网能直接连
   * （反代跑在 Docker 里也要选它）。frp 方式固定 127.0.0.1，frpc 在本机
   */
  listenHost: z.enum(['127.0.0.1', '0.0.0.0']).catch('127.0.0.1').default('127.0.0.1'),
  /** 直接监听时自己做 HTTPS：证书和私钥文件（PEM）路径，两个都填才启用；放在反向代理后面时留空 */
  tlsCert: z.string().trim().max(1000).default(''),
  tlsKey: z.string().trim().max(1000).default(''),
  /** 登录多少天没有活动就要重新登录；0 = 关掉浏览器就失效 */
  sessionDays: z.number().int().min(0).max(365).catch(7).default(7),
  /** 同一个来源连续输错几次密码锁定 */
  maxAttempts: z.number().int().min(1).max(50).catch(5).default(5),
  /** 锁定多少分钟 */
  lockMinutes: z.number().int().min(1).max(1440).catch(5).default(5),
  frp: RemoteFrp.prefault({}),
  tailscale: RemoteTailscale.prefault({}),
})
export type RemoteAccess = z.infer<typeof RemoteAccess>
