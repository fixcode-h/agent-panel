import { t } from './i18n.ts'

/**
 * 需要授权的外部 CLI：设置里列出来，用户授权一次，之后 Agent 在任务里可以直接调用。
 * 每个 CLI 的差异（怎么检测登录、怎么授权、怎么退出、怎么认账号）都写在这里，
 * 新增一个工具只要加一份定义，设置页和接口都不用改。
 */
export interface Integration {
  id: string
  name: string
  /** 授权后能做什么，设置页上的一句话 */
  description: string
  /** 可执行文件 */
  command: string
  versionArgs: string[]
  docsUrl?: string
  /** 装这个 CLI 的命令，按平台给（复制到终端里跑的那条） */
  install: Partial<Record<Platform, string>>
  /**
   * 一键安装：按平台给几种做法，按顺序用第一个能跑的（命令找得到），失败了再试下一个。
   * 'download' 表示下载到数据目录的 bin 下（要有 dataBin），不需要包管理器和管理员权限
   */
  setup?: Partial<Record<Platform, (string[] | 'download')[]>>
  /** Windows 上常见的安装目录（可以写 %ProgramFiles% 这类变量）：安装包没把它加进 PATH 时也能找到 */
  winDirs?: string[]
  /** 面板会把它下载到数据目录的 bin 下（例如 cloudflared），不在 PATH 里也能找到 */
  dataBin?: boolean
  auth: {
    /** 检测是否已登录：退出码 0 表示已登录；凭据是文件时不用这个 */
    status?: string[]
    /**
     * 退出码 0 之外还要输出里有这个才算已登录：有的 CLI 查状态总是返回 0，只在输出里写登录着谁
     * （例如 lark-cli auth status 没登录也是 0，输出 "identity": "none"）
     */
    authed?: RegExp
    /**
     * 登录前要先做的一步：检测输出匹配 when 时先跑 args（例如 lark-cli 没建应用时先 config init --new，
     * 它也打印一个网址、等浏览器里完成），跑完再跑 login
     */
    prepare?: { args: string[]; when: RegExp }
    /** 凭据文件（相对用户目录）：文件在就算已登录，没有查状态的命令时用它 */
    file?: string
    /** 浏览器授权 */
    login: string[]
    /** 用粘贴的 token 授权，token 从 stdin 传入 */
    token?: string[]
    /** 退出登录 */
    logout?: string[]
    /** 退出登录就是删掉这个文件（相对用户目录），没有退出命令时用它 */
    logoutFile?: string
    /** 从检测输出里认出账号：第一个捕获组是账号名 */
    account?: RegExp
    /** 从授权输出里找一次性授权码：第一个捕获组是码 */
    code?: RegExp
    /** 输出里出现这个就按一次回车（有的 CLI 会停在「按回车打开浏览器」） */
    ready?: RegExp
    /** 没登录时给用户看的一句话；工具自己的输出多半是英文 */
    hint?: string
    /**
     * 打印当前登录令牌的命令（stdout 一行令牌）和令牌能发往的主机：面板自己访问这些主机时带上它。
     * 例：gh 授权后，面板查更新、下载更新包走 GitHub API 的配额从每小时 60 次升到 5000 次
     */
    printToken?: { args: string[]; hosts: string[] }
  }
  /**
   * 不装 CLI 时的备用登录信息（例如飞书的 user_access_token）：面板加密存在本机数据目录（server/secrets/store.ts，
   * 命名空间 integration:<id>），网页只看得到末 4 位；用它的插件经 ctx.integrations.credentials(id) 读写（插件接口 19）
   */
  credentials?: IntegrationCredential[]
  /** 备用登录信息给谁用、什么时候用的一句话（界面文案） */
  credentialsNote?: string
  /** 每条命令都带上的环境变量（关掉分页器、更新提示等） */
  env?: Record<string, string>
  /** 检测、退出、用 token 授权时额外带上的环境变量（关掉交互提示） */
  quietEnv?: Record<string, string>
}

export type Platform = 'win32' | 'darwin' | 'linux'

/** 备用登录信息里的一项 */
export interface IntegrationCredential {
  key: string
  label: string
  /** 一句话说明（界面文案，定义里用 t() 包好） */
  desc?: string
  placeholder?: string
  /** 令牌、密钥：只给末 4 位；不是保密的（例如选哪个平台）界面上照原样显示 */
  secret: boolean
  /** 给了就是下拉选择，第一个是默认 */
  options?: { value: string; label: string }[]
}

/** 设置页和接口里的授权状态 */
export interface IntegrationView {
  id: string
  name: string
  description: string
  command: string
  docsUrl: string
  /** 当前平台能直接复制的安装命令 */
  installHint: string
  /** 当前平台支持一键安装 */
  canInstall: boolean
  installed: boolean
  /** 第一行版本信息；没安装时为空 */
  version: string
  authed: boolean
  /** 登录着的账号；有的工具认不出来时为空 */
  account: string
  /** 支持在面板里走浏览器授权 */
  browserAuth: boolean
  /** 支持用粘贴的 Token 授权 */
  tokenAuth: boolean
  /** 支持退出登录 */
  canLogout: boolean
  /** 没登录时给用户看的一句话（工具输出多半是英文） */
  hint: string
  /** 检测输出的末尾几行：没登录、多个账号时给用户看 */
  detail: string
  /** 备用登录信息的定义（没有时为空数组），值另走 integrationCredentialsContract */
  credentials: IntegrationCredential[]
  /** 备用登录信息给谁用、什么时候用的一句话 */
  credentialsNote: string
}

/** 正在进行的授权 */
export interface IntegrationLoginJob {
  id: string
  integration: string
  status: 'running' | 'done' | 'failed'
  /** CLI 打印的授权网址 */
  url: string
  /** 一次性授权码，要在浏览器里输入 */
  code: string
  /** CLI 的输出（最后一部分） */
  output: string
  error?: string
  startedAt: number
}

/** 正在进行的一键安装 */
export interface IntegrationInstallJob {
  integration: string
  status: 'running' | 'done' | 'failed'
  /** 正在用的安装方式，例如 winget install --id GitHub.cli */
  method: string
  /** 安装命令的输出（最后一部分） */
  output: string
  error?: string
  startedAt: number
}

/** GitHub CLI：授权后 Agent 可以直接用 gh 合并分支、看/建 PR、提交 issue */
const github: Integration = {
  id: 'github',
  name: 'GitHub CLI',
  description: t('授权后 Agent 可以直接用 gh 操作 GitHub 远端：合并分支、查看和创建 PR、提交 issue 等。'),
  command: 'gh',
  versionArgs: ['--version'],
  docsUrl: 'https://cli.github.com/',
  install: {
    win32: 'winget install --id GitHub.cli',
    darwin: 'brew install gh',
    linux: 'sudo apt install gh',
  },
  setup: {
    win32: [
      [
        'winget',
        'install',
        '--id',
        'GitHub.cli',
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
    ],
    darwin: [['brew', 'install', 'gh']],
    // sudo -n：没有免密 sudo 时直接失败，不会卡在输密码上
    linux: [
      ['brew', 'install', 'gh'],
      ['sudo', '-n', 'apt-get', 'install', '-y', 'gh'],
    ],
  },
  winDirs: ['%ProgramFiles%\\GitHub CLI', '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links'],
  auth: {
    status: ['auth', 'status'],
    // --web 打开浏览器；一次性授权码自己解析出来给用户复制
    login: ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'],
    token: ['auth', 'login', '--with-token', '--hostname', 'github.com'],
    logout: ['auth', 'logout', '--hostname', 'github.com', '--user', '{account}'],
    // 只发给 API：镜像、jsDelivr 是第三方，原地址的下载也不需要令牌
    printToken: { args: ['auth', 'token', '--hostname', 'github.com'], hosts: ['api.github.com'] },
    account: /Logged in to \S+ account (\S+)/,
    code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
    ready: /Press Enter/i,
    hint: t('还没有登录 GitHub。点「浏览器授权」，或者用 Personal Access Token 授权。'),
  },
  env: { GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1' },
  quietEnv: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
}

/** cloudflared：授权后 Agent 可以在任务里建隧道、把本机服务临时暴露到外网 */
const cloudflared: Integration = {
  id: 'cloudflared',
  name: 'cloudflared',
  description: t(
    '授权后 Agent 可以用 cloudflared 把本机服务通过 Cloudflare Tunnel 暴露到外网，例如给远程电脑看正在开发的面板。',
  ),
  command: 'cloudflared',
  versionArgs: ['--version'],
  docsUrl: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/',
  // 「外部访问」里能直接下载到数据目录，这里也认那个文件
  dataBin: true,
  install: {
    win32: 'winget install --id Cloudflare.cloudflared',
    darwin: 'brew install cloudflared',
    linux: 'sudo apt install cloudflared',
  },
  setup: {
    win32: [
      [
        'winget',
        'install',
        '--id',
        'Cloudflare.cloudflared',
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      'download',
    ],
    darwin: [['brew', 'install', 'cloudflared'], 'download'],
    linux: [['brew', 'install', 'cloudflared'], 'download'],
  },
  winDirs: [
    '%ProgramFiles(x86)%\\cloudflared',
    '%ProgramFiles%\\cloudflared',
    '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links',
  ],
  auth: {
    // 登录后 cloudflared 把证书写到 ~/.cloudflared/cert.pem，没有查状态的命令
    file: '.cloudflared/cert.pem',
    // 打开浏览器登录，回调时写出 cert.pem；没有一次性授权码
    login: ['tunnel', 'login'],
    // 退出就是删掉证书：面板之外没法吊销账号级证书
    logoutFile: '.cloudflared/cert.pem',
    hint: t('还没有登录 Cloudflare。点「浏览器授权」，在打开的页面里选一个域名即可。'),
  },
}

/**
 * Vercel CLI：授权后 Agent 可以直接用 vercel 部署、查看部署状态、管理域名和环境变量。
 * 命令行为按 vercel@65.2.0 的源码核对（未在真实账号上跑过 login/部署）。
 */
const vercel: Integration = {
  id: 'vercel',
  name: 'Vercel CLI',
  description: t('授权后 Agent 可以直接用 vercel 部署项目和预览、查看部署状态、管理域名与环境变量。'),
  command: 'vercel',
  versionArgs: ['--version'],
  docsUrl: 'https://vercel.com/docs/cli',
  install: {
    win32: 'npm i -g vercel',
    darwin: 'npm i -g vercel',
    linux: 'npm i -g vercel',
  },
  setup: {
    // 依次回退到 pnpm、yarn；Linux 多一条 sudo -n，没有免密 sudo 时直接失败，不会卡在输密码上
    win32: [
      ['npm', 'i', '-g', 'vercel'],
      ['pnpm', 'add', '-g', 'vercel'],
      ['yarn', 'global', 'add', 'vercel'],
    ],
    darwin: [
      ['npm', 'i', '-g', 'vercel'],
      ['pnpm', 'add', '-g', 'vercel'],
      ['yarn', 'global', 'add', 'vercel'],
    ],
    linux: [
      ['npm', 'i', '-g', 'vercel'],
      ['sudo', '-n', 'npm', 'i', '-g', 'vercel'],
      ['pnpm', 'add', '-g', 'vercel'],
      ['yarn', 'global', 'add', 'vercel'],
    ],
  },
  auth: {
    // 未登录输出 {"loggedIn":false} 且退出码 1；已登录的输出含 "username"（非 TTY 下默认只写一行用户名，JSON 更好认）
    status: ['whoami', '--format', 'json'],
    // device code flow：CLI 打印 https://vercel.com/oauth/device?user_code=XXXX-XXXX，然后等浏览器里完成授权
    login: ['login'],
    // 没有把 token 存进凭据的子命令（--token / VERCEL_TOKEN 只对单次命令生效），所以不配 token
    logout: ['logout'],
    account: /"username"\s*:\s*"([^"]+)"/,
    // 授权码就是授权链接里的 user_code，不依赖 CLI 额外打印的那句提示
    code: /[?&]user_code=([A-Za-z0-9-]{4,})/,
    hint: t(
      '还没有登录 Vercel。点「浏览器授权」，在打开的页面里完成授权；也可以给 vercel 命令设置 VERCEL_TOKEN 环境变量来用 Token。',
    ),
  },
  // 关掉每次命令的更新检查和遥测提示（vercel 认这两个变量）
  env: { NO_UPDATE_NOTIFIER: '1', VERCEL_TELEMETRY_DISABLED: '1' },
}

/** npm 全局装的 CLI 的一键安装：npm 不在时依次回退到 pnpm、yarn；Linux 多一条 sudo -n（没有免密 sudo 时直接失败，不卡在输密码上） */
const npmSetup = (pkg: string): Integration['setup'] => {
  const common: string[][] = [
    ['npm', 'i', '-g', pkg],
    ['pnpm', 'add', '-g', pkg],
    ['yarn', 'global', 'add', pkg],
  ]
  return {
    win32: common,
    darwin: common,
    linux: [common[0], ['sudo', '-n', 'npm', 'i', '-g', pkg], ...common.slice(1)],
  }
}

/**
 * 飞书 CLI（lark-cli，飞书官方）：飞书插件经它读写飞书文档、表格、多维表格和评论（用户 2026-11-24 要在账号授权里加飞书）。
 * 命令行为按 github.com/larksuite/cli v1.0.100 的源码核对（cmd/auth/status.go、login.go、cmd/config/init.go），
 * 没在真实账号上跑过：
 * - auth status 总是退出 0，输出 JSON 的 "identity" 是 user / bot / none，用户名在 identities.user.userName；
 *   还没建应用时报错 not configured（退出码非 0）
 * - 没建应用要先 config init --new（不在终端里时打印网址后等浏览器里建好），再 auth login --recommend（打印网址、轮询等授权）
 * - 不装 lark-cli 时飞书插件可以改用 token（备用登录信息），能做的事少一些（见插件 README）
 */
const feishu: Integration = {
  id: 'feishu',
  name: t('飞书 CLI'),
  description: t(
    '授权后飞书插件可以经 lark-cli 读写你的飞书文档、表格、多维表格和评论；每次读写都按插件的授权卡来，Agent 不能在终端里直接调 lark-cli。',
  ),
  command: 'lark-cli',
  versionArgs: ['--version'],
  docsUrl: 'https://github.com/larksuite/cli',
  install: {
    win32: 'npm i -g @larksuite/cli',
    darwin: 'npm i -g @larksuite/cli',
    linux: 'npm i -g @larksuite/cli',
  },
  setup: npmSetup('@larksuite/cli'),
  auth: {
    status: ['auth', 'status'],
    authed: /"identity"\s*:\s*"user"/,
    prepare: { args: ['config', 'init', '--new', '--lang', 'zh'], when: /not configured|config init/i },
    login: ['auth', 'login', '--recommend'],
    logout: ['auth', 'logout'],
    account: /"userName"\s*:\s*"([^"]+)"/,
    hint: t('还没有登录飞书。点「浏览器授权」：第一次会先在浏览器里建一个飞书应用，再登录授权。'),
  },
  credentialsNote: t(
    '不装 lark-cli 时，飞书插件可以用这里填的 token 登录（加密存在本机数据目录，网页只显示末 4 位）。token 方式改不了文档正文，也不能新建文档。',
  ),
  credentials: [
    {
      key: 'brand',
      label: t('开放平台'),
      secret: false,
      options: [
        { value: 'feishu', label: t('飞书（open.feishu.cn）') },
        { value: 'lark', label: t('Lark 国际版（open.larksuite.com）') },
      ],
    },
    {
      key: 'userToken',
      label: 'user_access_token',
      desc: t('用户身份的令牌（u- 开头），大约 2 小时过期'),
      placeholder: 'u-xxxx',
      secret: true,
    },
    {
      key: 'refreshToken',
      label: 'refresh_token',
      desc: t('选填：和 App ID、App Secret 一起填，token 过期时自动换新的'),
      secret: true,
    },
    {
      key: 'appId',
      label: 'App ID',
      desc: t('选填：拿 token 用的飞书应用（cli_ 开头）'),
      placeholder: 'cli_xxxx',
      secret: false,
    },
    { key: 'appSecret', label: 'App Secret', desc: t('选填：同一个应用的 App Secret'), secret: true },
  ],
}

/** 内置的授权工具；以后加 GitLab 之类只管往这里加一份定义 */
export const INTEGRATIONS: Integration[] = [github, cloudflared, vercel, feishu]

export const getIntegration = (id: string) => INTEGRATIONS.find((x) => x.id === id)

/**
 * 检测输出 → 是否已登录、登录着哪个账号。
 * 只认退出码：各家「没登录」的措辞不一样，退出码最稳；账号正则只对已登录的输出用。
 * 抽成纯函数，服务端检测和单元测试走同一份判断，测试不用起进程、不用连网。
 */
export function authState(def: Integration, code: number | null, output: string) {
  const authed = code === 0 && (!def.auth.authed || def.auth.authed.test(output))
  const account = authed && def.auth.account ? (output.match(def.auth.account)?.[1] ?? '') : ''
  return { authed, account }
}
