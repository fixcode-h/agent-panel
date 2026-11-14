import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import type { LibraryEntry, LibraryEntryContent } from '@shared/library'
import { t } from '@shared/i18n'
import { countFiles, toTree, visibleRows } from '@/lib/library-tree'
import { copyText } from '@/lib/copy-text'
import { IconButton } from '@/components/ui/icon-button'
import {
  BrowserSplit,
  FileBody,
  PathBar,
  ReaderNote,
  TreeBody,
  TreeButton,
  TreeHead,
  ViewSwitch,
  fileMeta,
  isMarkdown,
  mainIcon,
  rowLook,
  toggleFolded,
} from '@/components/library/skill-reader'

/** 主文件：树里置顶，打开技能时默认就看它（以前要先点一下，右边只有一个空框） */
const MAIN = 'SKILL.md'

/**
 * 只读的技能文件浏览（自带 Skill）：左边文件树，右边看内容。
 * Markdown 默认按渲染效果看，可切到带行号的源码；其它文件直接看源码。
 */
export function SkillBrowser({
  entries,
  truncated,
  read,
  resetKey,
}: {
  entries: LibraryEntry[]
  truncated?: boolean
  /** 读一个文件；主文件传空串 */
  read: (path: string) => Promise<LibraryEntryContent>
  /** 换技能时变：清空选中、回到主文件 */
  resetKey: string
}) {
  const rows = useMemo(() => toTree(entries), [entries])
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [picked, setPicked] = useState('')
  /** 读到的文件，连同是按哪个路径读的（主文件是空串） */
  const [file, setFile] = useState<{ at: string; c: LibraryEntryContent } | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  /** 打开文件的请求序号：连点时只认最后一次 */
  const opened = useRef(0)

  const open = (path: string) => {
    setPicked(path)
    setError('')
    const seq = ++opened.current
    read(path)
      .then((c) => {
        if (seq === opened.current) setFile({ at: path, c })
      })
      .catch((e) => {
        if (seq !== opened.current) return
        setFile(null)
        setError((e as Error).message)
      })
  }

  // 换技能：清掉上一个技能的内容，回到主文件
  useEffect(() => {
    setFolded(new Set())
    setFile(null)
    open('')
    // open 每次渲染都是新的函数，只在换技能时重来
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const path = picked || MAIN
  const md = isMarkdown(path)
  // 读回来的还是上一个文件时（连点、读取中）不画，免得路径栏和内容对不上
  const shown = file?.at === picked ? file.c : null

  return (
    <BrowserSplit
      tree={
        <>
          <TreeHead count={countFiles(rows) + 1} />
          <TreeBody>
            <TreeButton
              depth={0}
              title={MAIN}
              active={picked === ''}
              onClick={() => open('')}
              icon={mainIcon}
              label={MAIN}
              mono
            />
            {visibleRows(rows, folded).map((r) => (
              <TreeButton
                key={r.path}
                depth={r.depth}
                title={r.path}
                active={picked === r.path}
                onClick={() => (r.type === 'dir' ? setFolded((s) => toggleFolded(s, r.path)) : open(r.path))}
                {...rowLook(r, folded)}
              />
            ))}
            {truncated && <p className="px-2 py-2 text-footnote text-subtle">{t('文件太多，只显示了前面一部分。')}</p>}
          </TreeBody>
        </>
      }
    >
      <PathBar path={path} meta={shown && !shown.binary ? fileMeta(shown.content, shown.size) : undefined}>
        {md && <ViewSwitch value={mode} onChange={setMode} source={{ id: 'source', label: t('源码') }} />}
        <IconButton
          icon={Copy}
          size="sm"
          label={t('复制内容')}
          disabled={!shown || shown.binary}
          onClick={() => shown && void copyText(shown.content, { done: t('已复制') })}
        />
      </PathBar>
      <div data-skill-reader="" className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ReaderNote tone="warning">{t('读取失败：{error}', { error })}</ReaderNote>
        ) : shown ? (
          <FileBody file={shown} preview={md && mode === 'preview'} />
        ) : null}
      </div>
    </BrowserSplit>
  )
}
