/**
 * 面板自己要用的本机程序（不是给 Agent 授权的 CLI，那些在 shared/integrations.ts）：没装时功能只能降级，
 * 面板在对话的输入框上方问一次「安装 / 拒绝」，点安装就在后台作业里装（server/local-programs/）。
 * 新加一个只要在这里加一份定义，提醒卡片、安装、接口都不用改
 */
import { z } from 'zod'
import { t } from '../i18n.ts'

export type ProgramPlatform = 'win32' | 'darwin' | 'linux'

export interface LocalProgram {
  id: string
  /** 显示名 */
  name: string
  /** 可执行文件 */
  command: string
  /** 没装时少了什么（提醒卡片上的一句话） */
  why: string
  /** 手动装的命令（复制到终端里跑的那条），按平台 */
  install: Partial<Record<ProgramPlatform, string>>
  /** 一键安装：按顺序用第一个找得到程序的做法，失败了再试下一个；sudo 一律带 -n，没有免密 sudo 时直接失败不卡住 */
  setup: Partial<Record<ProgramPlatform, string[][]>>
}

const rg: LocalProgram = {
  id: 'rg',
  name: 'rg（ripgrep）',
  command: 'rg',
  why: t('find 按文本找要用它一次查全；没装时只能逐个读文件，大项目里慢，还可能查不全。'),
  install: {
    win32: 'winget install --id BurntSushi.ripgrep.MSVC -e',
    darwin: 'brew install ripgrep',
    linux: 'sudo apt install ripgrep',
  },
  setup: {
    win32: [
      [
        'winget',
        'install',
        '--id',
        'BurntSushi.ripgrep.MSVC',
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      ['scoop', 'install', 'ripgrep'],
      ['choco', 'install', 'ripgrep', '-y'],
    ],
    darwin: [['brew', 'install', 'ripgrep']],
    linux: [
      ['brew', 'install', 'ripgrep'],
      ['sudo', '-n', 'apt-get', 'install', '-y', 'ripgrep'],
      ['sudo', '-n', 'dnf', 'install', '-y', 'ripgrep'],
    ],
  },
}

export const LOCAL_PROGRAMS: LocalProgram[] = [rg]

export const localProgram = (id: string) => LOCAL_PROGRAMS.find((p) => p.id === id)

/** 输入框上方的「没装 X，装不装」：一个程序一条 */
export const ProgramOffer = z.object({
  id: z.string(),
  name: z.string(),
  why: z.string(),
  /** 手动装的命令（一键安装失败或没有可用做法时给用户复制） */
  installHint: z.string(),
  /** 这台电脑上有能用的一键安装做法（包管理器找得到） */
  canInstall: z.boolean(),
  /** 正在装：后台作业的编号（侧栏底部的作业列表里看日志、取消） */
  jobId: z.string().optional(),
  /** 上次一键安装失败的原因 */
  error: z.string().optional(),
})
export type ProgramOffer = z.infer<typeof ProgramOffer>
