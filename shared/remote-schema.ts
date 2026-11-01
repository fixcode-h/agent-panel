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

export const RemoteAccess = z.object({
  enabled: z.boolean().default(false),
  /** quick：Cloudflare 临时地址（重启后变）；token：Cloudflare Tunnel（固定域名）；custom：自己搭的反向代理；frp：一键配置的云服务器 */
  mode: z.enum(['quick', 'token', 'custom', 'frp']).catch('quick').default('quick'),
  /** Cloudflare Tunnel 的 token（mode=token 时用），也可以在 cloudflared 里预先配置好 */
  tunnelToken: z.string().trim().max(4000).default(''),
  /** 外网地址：token 模式填隧道的域名，custom 模式填反向代理后的地址；quick 模式自动生成 */
  publicUrl: z.string().trim().max(300).default(''),
  /** cloudflared 可执行文件；留空时依次找数据目录的 bin/ 和 PATH */
  command: z.string().trim().max(500).default(''),
  /**
   * 外网请求专用的本机端口（只监听 127.0.0.1）：隧道、frpc、反向代理都转到这里。
   * 从这个端口进来的请求一律当外网处理（必须带访问令牌），不再靠 Host 头判断——
   * 反向代理把 Host 改成 127.0.0.1 时，按 Host 判断会把外网请求当成本机、绕过令牌
   */
  localPort: z.number().int().min(1).max(65535).catch(8788).default(8788),
  frp: RemoteFrp.prefault({}),
})
export type RemoteAccess = z.infer<typeof RemoteAccess>
