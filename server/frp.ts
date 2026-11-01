import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { access, chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Client } from 'ssh2'
import { homedir } from 'node:os'
import type { FrpMapping, RemoteFrp } from '../shared/schema.ts'
import { frpMappingError, mappingProxyName, tomlString } from '../shared/remote.ts'
import { stripAnsi } from '../shared/ansi.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR } from './store.ts'
import { downloadFile } from './download.ts'
import { log } from './log.ts'

/**
 * 「云服务器（frp）」：面板用 SSH 登录用户的云服务器（先支持阿里云 ECS 这类装了 systemd 的 Linux），
 * 把 frps 装成系统服务；本机跑 frpc，把服务器上的 remotePort 转到面板的外网专用端口。
 * 版本固定：frps 和 frpc 版本一致最稳，升级时两边一起换。
 */
export const FRP_VERSION = '0.61.1'

const execFileAsync = promisify(execFile)
const BIN = path.join(DATA_DIR, 'bin')
export const FRPC_FILE = path.join(BIN, process.platform === 'win32' ? 'frpc.exe' : 'frpc')
/** frpc 的配置写在数据目录里（里面有 frp 令牌），每次启动按设置重写 */
export const FRPC_CONFIG = path.join(DATA_DIR, 'frp', 'frpc.toml')

/** 服务器上用的名字：和用户自己装的 frps 分开，不覆盖它 */
const REMOTE_BIN = '/usr/local/bin/agent-panel-frps'
const REMOTE_DIR = '/etc/agent-panel-frp'
const SERVICE = 'agent-panel-frps'

/**
 * 官方发布页 frp_sha256_checksums.txt 里各平台包的哈希（版本固定，直接写死比再下一次校验文件更可靠）。
 * 下载后逐一核对，防止被网络中间人或镜像换掉；升级 FRP_VERSION 时一起更新
 */
export const FRP_SHA256: Record<string, string> = {
  'frp_0.61.1_linux_amd64.tar.gz': 'bff260b68ca7b1461182a46c4f34e9709ba32764eed30a15dd94ac97f50a2c40',
  'frp_0.61.1_linux_arm64.tar.gz': 'af6366f2b43920ebfe6235dba6060770399ed1fb18601e5818552bd46a7621f8',
  'frp_0.61.1_darwin_amd64.tar.gz': '403a0ee5e92f083a863d984b7af1e9d70ba2aaa28e87f42f1fe085adf76b8491',
  'frp_0.61.1_darwin_arm64.tar.gz': '3e65f13a17a284bd6013e6bb6856bc2720074cea6094cc446c1f4c3932154c2d',
  'frp_0.61.1_windows_amd64.zip': 'e0094cd0baf03d5ff9ce9739199406871ad8788cf51e766f00ad3a9e7a836f3a',
  'frp_0.61.1_windows_arm64.zip': '099914b6f66b1d983a9402e3a9a116bccc683c877f6dbfbbb5c0f171b584675f',
}

/** 文件的 SHA256（十六进制） */
async function sha256File(file: string) {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

/** frpc 所在的目录：被安全软件隔离时要把它加进信任区 */
export const FRP_BIN_DIR = BIN

export const newFrpToken = () => randomBytes(24).toString('hex')

/** frp 发布包的名字：os 用 frp 自己的叫法（linux / darwin / windows） */
export function frpAsset(os: string, arch: string) {
  const a = arch === 'arm64' || arch === 'aarch64' ? 'arm64' : arch === 'x64' || arch === 'x86_64' ? 'amd64' : ''
  const o = os === 'win32' || os === 'windows' ? 'windows' : os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : ''
  if (!a || !o) return undefined
  const dir = `frp_${FRP_VERSION}_${o}_${a}`
  const name = `${dir}${o === 'windows' ? '.zip' : '.tar.gz'}`
  return { dir, name, url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}` }
}

const q = tomlString

type ServerSide = Pick<RemoteFrp, 'bindPort' | 'remotePort' | 'token' | 'rangeStart' | 'rangeEnd'>

export function frpsConfig(f: ServerSide) {
  return [
    `bindPort = ${f.bindPort}`,
    'auth.method = "token"',
    `auth.token = ${q(f.token)}`,
    // 只允许面板端口和端口映射的那一段：令牌泄露了也开不出别的端口
    `allowPorts = [{ single = ${f.remotePort} }, { start = ${f.rangeStart}, end = ${f.rangeEnd} }]`,
    '',
  ].join('\n')
}

/** ~ 开头的目录按用户目录展开：frp 不认 ~ */
const expandHome = (p: string) => (p === '~' || /^~[\\/]/.test(p) ? path.join(homedir(), p.slice(1)) : p)

/** 一条映射在 frpc 配置里的代理段 */
function mappingProxies(m: FrpMapping): string[] {
  const name = mappingProxyName(m.id)
  // frpc 和 frps 之间加密
  const enc = 'transport.useEncryption = true'
  if (m.type === 'files')
    return [
      '[[proxies]]',
      `name = ${q(name)}`,
      'type = "tcp"',
      `remotePort = ${m.remotePort}`,
      enc,
      '[proxies.plugin]',
      'type = "static_file"',
      `localPath = ${q(expandHome(m.localPath))}`,
      `httpUser = ${q(m.httpUser)}`,
      `httpPassword = ${q(m.httpPassword)}`,
      '',
    ]
  const local = [`localIP = ${q(m.localIP || '127.0.0.1')}`, `localPort = ${m.localPort}`]
  if (m.type === 'xtcp')
    // P2P：先打洞直连；打不通时访问端退回同密钥的 stcp，经服务器中转。两条都不占服务器端口
    return [
      '[[proxies]]',
      `name = ${q(name)}`,
      'type = "xtcp"',
      `secretKey = ${q(m.secretKey)}`,
      ...local,
      enc,
      '',
      '[[proxies]]',
      `name = ${q(`${name}-stcp`)}`,
      'type = "stcp"',
      `secretKey = ${q(m.secretKey)}`,
      ...local,
      enc,
      '',
    ]
  return ['[[proxies]]', `name = ${q(name)}`, `type = ${q(m.type)}`, ...local, `remotePort = ${m.remotePort}`, enc, '']
}

export function frpcConfig(
  f: Pick<RemoteFrp, 'server' | 'bindPort' | 'remotePort' | 'token' | 'rangeStart' | 'rangeEnd' | 'mappings'>,
  localPort: number,
) {
  // 不合法的映射（端口不在范围、重复）不写进去：写进去 frps 也会拒绝，界面上已经标出原因
  const maps = f.mappings.filter((m) => m.enabled && !frpMappingError(m, f))
  return [
    `serverAddr = ${q(f.server)}`,
    `serverPort = ${f.bindPort}`,
    'auth.method = "token"',
    `auth.token = ${q(f.token)}`,
    // 第一次连不上（安全组没放行、网络抖动）也不退出，一直重试；状态在设置页显示
    'loginFailExit = false',
    // 输出要解析、显示在设置页：不要颜色控制符
    'log.disablePrintColor = true',
    '',
    '[[proxies]]',
    'name = "agent-panel"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
    `remotePort = ${f.remotePort}`,
    // frpc 和 frps 之间加密；浏览器到服务器这一段仍是 http
    'transport.useEncryption = true',
    '',
    ...maps.flatMap(mappingProxies),
  ].join('\n')
}

/** 服务器上执行的安装脚本：装 frps、写配置、注册 systemd 服务、放行系统防火墙 */
export function deployScript(f: ServerSide, uploaded: string) {
  const range = `${f.rangeStart}-${f.rangeEnd}`
  return [
    'set -e',
    'command -v systemctl >/dev/null 2>&1 || { echo "AGENT_PANEL_ERR no-systemd"; exit 3; }',
    `install -m 755 ${uploaded} ${REMOTE_BIN}`,
    `rm -f ${uploaded}`,
    `mkdir -p ${REMOTE_DIR}`,
    `cat > ${REMOTE_DIR}/frps.toml <<'AGENT_PANEL_EOF'`,
    frpsConfig(f).trimEnd(),
    'AGENT_PANEL_EOF',
    `chmod 600 ${REMOTE_DIR}/frps.toml`,
    `cat > /etc/systemd/system/${SERVICE}.service <<'AGENT_PANEL_EOF'`,
    '[Unit]',
    'Description=Agent Panel frps',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${REMOTE_BIN} -c ${REMOTE_DIR}/frps.toml`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'AGENT_PANEL_EOF',
    // 端口被别的程序占着时 frps 起不来，或者 frpc 连上的是那个程序（握手时被断开、报 session shutdown）：
    // 先查清楚是谁占着，直接告诉用户。进程名在 ss 里最多 15 个字符，agent-panel-frps 显示成 agent-panel-frp
    `for p in ${f.bindPort} ${f.remotePort}; do`,
    '  owner=$(ss -ltnpH "sport = :$p" 2>/dev/null | grep -o \'users:(("[^"]*"\' | head -1 | cut -d\'"\' -f2)',
    '  case "$owner" in ""|agent-panel-frp*) ;; *) echo "AGENT_PANEL_ERR port-busy $p $owner"; exit 5 ;; esac',
    'done',
    'systemctl daemon-reload',
    `systemctl enable ${SERVICE} >/dev/null 2>&1 || true`,
    `systemctl restart ${SERVICE}`,
    // 系统防火墙开着时放行这些端口；阿里云的安全组在控制台里，脚本改不了
    'if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
    `  firewall-cmd --permanent --add-port=${f.bindPort}/tcp >/dev/null`,
    `  firewall-cmd --permanent --add-port=${f.remotePort}/tcp >/dev/null`,
    `  firewall-cmd --permanent --add-port=${range}/tcp >/dev/null`,
    `  firewall-cmd --permanent --add-port=${range}/udp >/dev/null`,
    '  firewall-cmd --reload >/dev/null',
    'fi',
    'if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then',
    `  ufw allow ${f.bindPort}/tcp >/dev/null`,
    `  ufw allow ${f.remotePort}/tcp >/dev/null`,
    `  ufw allow ${f.rangeStart}:${f.rangeEnd}/tcp >/dev/null`,
    `  ufw allow ${f.rangeStart}:${f.rangeEnd}/udp >/dev/null`,
    'fi',
    'sleep 1',
    `if ! systemctl is-active --quiet ${SERVICE}; then journalctl -u ${SERVICE} -n 20 --no-pager 2>/dev/null || true; echo "AGENT_PANEL_ERR not-active"; exit 4; fi`,
    'echo AGENT_PANEL_OK',
    '',
  ].join('\n')
}

/** 下载并解出 frp 包里的一个程序（frpc / frps），返回它的路径 */
async function fetchFrpBinary(
  os: string,
  arch: string,
  name: 'frpc' | 'frps',
  to: string,
  onPercent: (n: number) => void,
) {
  const a = frpAsset(os, arch)
  if (!a) throw new Error(t('不支持这个系统：{os} {arch}', { os, arch }))
  const work = path.join(BIN, `.frp-${a.dir}`)
  const archive = path.join(BIN, a.name)
  let total = 0
  let got = 0
  await downloadFile(a.url, archive, {
    onTotal: (n) => (total = n),
    onBytes: (n) => {
      got += n
      onPercent(total ? Math.min(100, Math.round((got / total) * 100)) : -1)
    },
    signal: AbortSignal.timeout(10 * 60_000),
  })
  const want = FRP_SHA256[a.name]
  const got256 = await sha256File(archive)
  if (!want || got256 !== want) {
    await rm(archive, { force: true })
    throw new Error(
      t('下载的 {name} 校验不通过（SHA256 {got}），已删除。可能被网络或镜像篡改，请换个网络再试。', {
        name: a.name,
        got: got256,
      }),
    )
  }
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  try {
    // Windows 10 起自带的 tar 也能解 zip
    await execFileAsync('tar', ['-xf', archive, '-C', work])
    const exe = `${name}${a.name.endsWith('.zip') ? '.exe' : ''}`
    const inner = path.join(work, a.dir, exe)
    const found = (await readdir(path.join(work, a.dir)).catch(() => [] as string[])).includes(exe)
    if (!found) throw new Error(t('frp 安装包里没有 {name}', { name: exe }))
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(inner, to)
    if (!a.name.endsWith('.zip')) await chmod(to, 0o755)
  } finally {
    await rm(work, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
  return to
}

/** 本机的 frpc：没有就下载到数据目录 */
export async function ensureFrpc(onPercent: (n: number) => void = () => {}) {
  try {
    await access(FRPC_FILE)
    return FRPC_FILE
  } catch {}
  log.info('remote', '下载 frpc', { version: FRP_VERSION })
  return fetchFrpBinary(process.platform, process.arch, 'frpc', FRPC_FILE, onPercent)
}

export interface DeployInput {
  server: string
  sshPort: number
  sshUser: string
  password: string
  bindPort: number
  remotePort: number
  rangeStart: number
  rangeEnd: number
  token: string
}

export type DeployStep = 'connect' | 'download' | 'upload' | 'install' | 'done'

type Conn = Client

async function connect(i: DeployInput): Promise<Conn> {
  // 用到时才加载 ssh2：它加载时会做平台相关的初始化，没必要拖慢面板启动、也不该让启动因它失败
  const { default: ssh2 } = await import('ssh2')
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client()
    c.on('ready', () => resolve(c))
    c.on('error', (e) => reject(e))
    c.connect({
      host: i.server,
      port: i.sshPort,
      username: i.sshUser,
      password: i.password,
      // 部分镜像只开了 keyboard-interactive：用同一个密码应答
      tryKeyboard: true,
      readyTimeout: 20_000,
    })
    c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => i.password)))
  })
}

/** 在服务器上跑一条命令；stdin 写入 input。返回退出码和输出 */
function run(c: Conn, cmd: string, input = '') {
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (b: Buffer) => (out += b.toString()))
      stream.stderr.on('data', (b: Buffer) => (out += b.toString()))
      stream.on('close', (code: number | null) => resolve({ code: code ?? -1, out: out.slice(-4000) }))
      stream.end(input)
    })
  })
}

function upload(c: Conn, local: string, remote: string) {
  return new Promise<void>((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err)
      sftp.fastPut(local, remote, (e) => {
        sftp.end()
        if (e) reject(e)
        else resolve()
      })
    })
  })
}

/** 把 SSH 的英文报错换成用户看得懂的原因（原文附在后面，不吞掉） */
export function sshError(e: Error, i: Pick<DeployInput, 'server' | 'sshPort'>) {
  const m = e.message
  if (/authentication methods failed|All configured authentication/i.test(m))
    return t('SSH 登录失败：用户名或密码不对（{msg}）', { msg: m })
  if (/ETIMEDOUT|Timed out while waiting for handshake|EHOSTUNREACH/i.test(m))
    return t('连不上 {server}:{port}：请确认 IP 正确，并在阿里云安全组里放行 SSH 端口（{msg}）', {
      server: i.server,
      port: String(i.sshPort),
      msg: m,
    })
  if (/ECONNREFUSED/i.test(m))
    return t('{server}:{port} 拒绝连接：SSH 端口不对或 sshd 没开（{msg}）', {
      server: i.server,
      port: String(i.sshPort),
      msg: m,
    })
  return m
}

/**
 * 一键配置：登录服务器 → 按服务器的 CPU 下载 frps → 上传 → 装成 systemd 服务。
 * 密码只在这次连接里用，不写盘也不写日志。
 */
export async function deployFrps(i: DeployInput, onStep: (s: DeployStep, percent?: number) => void) {
  onStep('connect')
  let c: Conn
  try {
    c = await connect(i)
  } catch (e) {
    throw new Error(sshError(e as Error, i))
  }
  try {
    const who = await run(c, 'uname -sm; id -u')
    const [sys = '', arch = ''] = (who.out.split('\n')[0] ?? '').trim().split(/\s+/)
    const root = (who.out.split('\n')[1] ?? '').trim() === '0'
    if (sys.toLowerCase() !== 'linux')
      throw new Error(t('目前只支持 Linux 服务器（检测到 {sys}）', { sys: sys || '?' }))
    onStep('download', -1)
    const local = path.join(BIN, `frps-linux-${arch}`)
    await fetchFrpBinary('linux', arch, 'frps', local, (n) => onStep('download', n))
    onStep('upload')
    const remoteTmp = `/tmp/agent-panel-frps-${randomBytes(4).toString('hex')}`
    await upload(c, local, remoteTmp)
    await rm(local, { force: true })
    onStep('install')
    const script = deployScript(i, remoteTmp)
    // 非 root 用户用 sudo：密码从标准输入的第一行给 sudo，剩下的是脚本
    const r = root ? await run(c, 'bash -s', script) : await run(c, "sudo -S -p '' bash -s", `${i.password}\n${script}`)
    if (r.code !== 0 || !r.out.includes('AGENT_PANEL_OK')) {
      if (r.out.includes('no-systemd')) throw new Error(t('服务器上没有 systemd，暂不支持自动配置'))
      const busy = r.out.match(/AGENT_PANEL_ERR port-busy (\d+) (\S+)/)
      if (busy)
        throw new Error(
          t('服务器上的端口 {port} 已经被 {name} 占用：停掉它，或在「高级 · 端口」里换一个端口后重新配置。', {
            port: busy[1],
            name: busy[2],
          }),
        )
      throw new Error(
        t('在服务器上安装 frps 失败（退出码 {code}）：{log}', { code: String(r.code), log: r.out.trim() }),
      )
    }
    log.info('remote', 'frps 已部署', { server: i.server, bindPort: i.bindPort, remotePort: i.remotePort })
    onStep('done')
  } finally {
    c.end()
  }
}

/** frpc 的一行日志去掉颜色控制符和「时间 [级别] [源文件]」前缀，只留给人看的部分 */
export function frpcLine(line: string) {
  return stripAnsi(line)
    .replace(/^\s*\d{4}-\d{2}-\d{2} [\d:.]+ \[\w\] (\[[^\]]*\.go:\d+\] )?/, '')
    .trim()
}

/** frpc 日志里是哪一条代理：面板自己是 agent-panel，端口映射是 agent-panel-m-<id> */
export function frpcProxyOf(line: string) {
  return line.match(/\[(agent-panel(?:-m-[a-z0-9]+)?)(?:-stcp)?\]/)?.[1] ?? ''
}

/** frpc 的输出：连上并开好端口、连不上服务器、令牌被拒 */
export type FrpcEvent = 'ok' | 'auth' | 'port' | 'local' | 'closed' | 'refused' | 'unreachable' | ''

/**
 * frpc 的输出归类。「connect to server error」后面跟的原因决定该让用户查什么，不能一律当成端口没放行：
 * - local：映射连不上本机服务（本机没开 SSH 之类）
 * - closed：TCP 已经连上 frp 端口，但对方握手阶段就断开（端口被别的程序占着、不是这版 frps）
 * - refused：服务器上这个端口没有程序在听（frps 没在运行）
 * - unreachable：超时、路由不通（安全组 / 防火墙没放行）
 */
export function frpcEvent(line: string): FrpcEvent {
  if (/start proxy success/i.test(line)) return 'ok'
  if (/token in login doesn't match|authorization failed|authentication/i.test(line)) return 'auth'
  if (/port not allowed|port already used|port unavailable/i.test(line)) return 'port'
  if (/connect to local service/i.test(line)) return 'local'
  if (!/connect to server error|login to the server failed|dial tcp|i\/o timeout/i.test(line)) return ''
  if (/session shutdown|\bEOF\b|connection reset|broken pipe/i.test(line)) return 'closed'
  if (/connection refused|actively refused|积极拒绝/i.test(line)) return 'refused'
  return 'unreachable'
}
