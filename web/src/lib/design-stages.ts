import { t } from '@shared/i18n'

/**
 * UI 设计的流程：风格 → 原画 → 模板 → 界面 → 切图 → 导出。按设计里已有的东西推出每一步的状态，
 * 第一个没做完的就是「当前」，并给一句下一步做什么。步骤顺序不强制：可以不出原画直接搭界面，这时原画、模板记为跳过
 */
export type StageId = 'style' | 'concept' | 'template' | 'ui' | 'slices' | 'export'
export type StageState = 'done' | 'current' | 'todo' | 'skipped' | 'busy'

export interface Stage {
  id: StageId
  label: string
  state: StageState
  /** 当前这一步要做什么（给悬停提示和标题行的说明） */
  hint: string
}

export interface StageInput {
  style: string
  concepts: number
  approved: boolean
  /** 控件树里有没有东西（根下面有子控件） */
  hasTree: boolean
  images: { status: string; variants: number }[]
  /** 正在出原画 / 搭界面 / 出图 */
  running?: 'concepts' | 'design' | 'images'
}

export function designStages(i: StageInput): Stage[] {
  const imgsDone = i.images.length > 0 && i.images.every((x) => x.variants > 0 && x.status !== 'failed')
  const imgsBusy = i.images.some((x) => x.status === 'generating' || x.status === 'pending')
  const base: { id: StageId; label: string; done: boolean; skipped?: boolean; busy?: boolean; hint: string }[] = [
    {
      id: 'style',
      label: t('风格'),
      done: !!i.style.trim(),
      // 没定风格也能往下做（AI 会问），后面的步骤做了就不再把它当成当前步骤
      skipped: !i.style.trim() && (i.concepts > 0 || i.hasTree),
      hint: t('告诉 AI 想要什么风格，或者在风格按钮里选一个'),
    },
    {
      id: 'concept',
      label: t('原画'),
      done: i.concepts > 0,
      skipped: !i.concepts && i.hasTree,
      busy: i.running === 'concepts',
      hint: t('在输入框打开「原画」再描述界面，AI 先画几张整屏原画给你挑'),
    },
    {
      id: 'template',
      label: t('模板'),
      done: i.approved,
      skipped: !i.approved && i.hasTree,
      hint: t('在原画里挑一张，标注要改的地方或点「用这张做模板」'),
    },
    {
      id: 'ui',
      label: t('界面'),
      done: i.hasTree,
      busy: i.running === 'design',
      hint: t('让 AI 照着模板或描述搭界面'),
    },
    {
      id: 'slices',
      label: t('切图'),
      done: imgsDone,
      busy: i.running === 'images' || imgsBusy,
      hint: i.images.length ? t('在「图片」页签生成、重试或替换切图') : t('让 AI 列出要生成的切图'),
    },
    { id: 'export', label: t('导出'), done: false, hint: t('点右上角的导出，给 UE 或网页用') },
  ]
  let current = false
  return base.map((s) => {
    let state: StageState
    if (s.busy) state = 'busy'
    else if (s.done) state = 'done'
    else if (s.skipped) state = 'skipped'
    else if (!current) state = 'current'
    else state = 'todo'
    if (state === 'current' || state === 'busy') current = true
    return { id: s.id, label: s.label, state, hint: s.hint }
  })
}
