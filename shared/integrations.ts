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
  }
  /** 每条命令都带上的环境变量（关掉分页器、更新提示等） */
  env?: Record<string, string>
  /** 检测、退出、用 token 授权时额外带上的环境变量（关掉交互提示） */
  quietEnv?: Record<string, string>
}

export type Platform = 'win32' | 'darwin' | 'linux'

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

/** 内置的授权工具；以后加 GitLab 之类只管往这里加一份定义 */
export const INTEGRATIONS: Integration[] = [github, cloudflared]

export const getIntegration = (id: string) => INTEGRATIONS.find((x) => x.id === id)
