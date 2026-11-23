/**
 * 国内镜像（注册表，可统一能力盘点第 11 项，开放给插件）：同一份文件在官方站和国内镜像站的地址对照。
 *
 * 为什么要有：npm、Hugging Face、ffmpeg 这类下载以前各写一份镜像地址（语音、本机生图、UE 的 OCR、视频插件的 ffmpeg），
 * 地址写错一处、镜像站换域名都要改好几处。现在地址只在这里，调用方按自己的「用国内镜像」开关取候选地址，
 * 依次试（下载失败换下一个）。GitHub 上的文件另有「GitHub 下载来源」（shared/github-sources），这里只管 GitHub 以外的站。
 *
 * 加一种：在 MIRRORS 里加一项，official / mirror 是同一路径前面的那段；设置 →「网络与代理」会列出来。
 */
import { t } from '../i18n.ts'

export interface MirrorDef {
  id: string
  /** 给人看的名字（设置页列表） */
  label: string
  official: string
  mirror: string
  /** 哪些功能在用（设置页列表；开关在各功能自己的设置里） */
  usedBy: () => string
}

export const MIRRORS = [
  {
    id: 'npm',
    label: 'npm',
    official: 'https://registry.npmjs.org',
    mirror: 'https://registry.npmmirror.com',
    usedBy: () => t('语音输入的识别库、UE 插件的文字识别（OCR）'),
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    official: 'https://huggingface.co',
    mirror: 'https://hf-mirror.com',
    usedBy: () => t('语音输入、本机生图的模型'),
  },
  {
    id: 'pypi',
    label: 'PyPI',
    official: 'https://pypi.org/simple',
    mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    usedBy: () => t('本机生图的 Python 依赖'),
  },
  {
    // ffmpeg-static 的各平台单文件：官方在 GitHub Release，npmmirror 的二进制镜像同路径
    id: 'ffmpeg-static',
    label: 'ffmpeg-static',
    official: 'https://github.com/eugeneware/ffmpeg-static/releases/download',
    mirror: 'https://registry.npmmirror.com/-/binary/ffmpeg-static',
    usedBy: () => t('视频插件的 FFmpeg'),
  },
] as const satisfies readonly MirrorDef[]

export type MirrorId = (typeof MIRRORS)[number]['id']

export const mirrorDef = (id: MirrorId): MirrorDef => MIRRORS.find((m) => m.id === id)!

/** 一个路径的候选地址：用镜像时镜像在前、官方兜底，不用时只给官方（用户没开镜像就不往第三方站发请求） */
export function mirrorUrls(id: MirrorId, path: string, useMirror: boolean): string[] {
  const m = mirrorDef(id)
  const p = path.startsWith('/') ? path : `/${path}`
  return useMirror ? [`${m.mirror}${p}`, `${m.official}${p}`] : [`${m.official}${p}`]
}

/** 只要第一个候选（只能给一个地址的地方） */
export const mirrorUrl = (id: MirrorId, path: string, useMirror: boolean) => mirrorUrls(id, path, useMirror)[0]

/** 官方地址换成镜像地址（已有一个完整的官方地址时）；不是这个站的地址原样返回 */
export function toMirror(id: MirrorId, url: string, useMirror: boolean) {
  const m = mirrorDef(id)
  return useMirror && url.startsWith(`${m.official}/`) ? m.mirror + url.slice(m.official.length) : url
}
