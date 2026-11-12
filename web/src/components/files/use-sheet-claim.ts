/**
 * 文件弹窗里的表格文件归不归某个插件（插件网页 SDK 的 SheetClaimer，分析稿第 26、27 条）：
 * 表格插件认领项目表格目录里的文件，弹窗就多一个「在表格页打开」，表头和两行列头按项目的表格设置来。
 * 插件开关、换了文件都重新问；插件说结构变了（保存了表头）时 version 加一，调用方据此重新取表头
 */
import { useEffect, useMemo, useState } from 'react'
import { joinPath } from '@shared/doc-root'
import { claimSheet, usePlugins } from '@/plugins/registry'
import type { SheetClaim, SheetFile } from '@/plugins/sdk'
import { useSheetView } from './use-sheet-view'

export function useSheetClaim(file: SheetFile | null) {
  const plugins = usePlugins()
  const [got, setGot] = useState<{ key: string; claim: (SheetClaim & { plugin: string }) | undefined } | null>(null)
  const [version, setVersion] = useState(0)
  const key = file ? `${file.projectId}\n${file.root}\n${file.path}` : ''
  useEffect(() => {
    if (!file) return setGot(null)
    let live = true
    void claimSheet(file, plugins).then((claim) => live && setGot({ key, claim }))
    return () => {
      live = false
    }
    // file 每次渲染都是新对象：按 key（项目 + 根目录 + 路径）和插件列表重新问
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, plugins.web])
  // 换了文件、上一个文件的回答还没换掉时不用旧的
  const claim = got?.key === key ? got.claim : undefined
  useEffect(() => claim?.subscribe?.(() => setVersion((v) => v + 1)), [claim])
  return { claim, version }
}

/**
 * 文件弹窗里一张表的查看状态（表头、筛选、排序）：插件认领了就用插件给的表头和两行列头，
 * 否则照旧自动识别、手动调的记在本机（use-sheet-view.ts）
 */
export function useClaimedSheetView({
  file,
  projectId,
  root,
  key,
  sheet,
  rows,
}: {
  /** 读回来的表格文件；不是表格时为 null */
  file: { path: string } | null
  projectId?: string
  /** 弹窗读文件的根目录：相对路径接在它后面 */
  root: string
  /** 本机记手动表头的键：路径 + 工作表 */
  key: string
  sheet: string
  rows: string[][] | null
}) {
  const { claim, version } = useSheetClaim(
    file && projectId && root ? { path: joinPath(root, file.path), projectId, root } : null,
  )
  const store = useMemo(
    () => (claim?.header && rows ? claim.header(sheet, rows) : undefined),
    // version：插件那边保存了表头，重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [claim, sheet, rows, version],
  )
  const view = useSheetView(key, rows, store)
  const header = view?.header
  const colHeads = useMemo(
    () => (claim?.colHeads && rows && header ? claim.colHeads(sheet, rows, header) : undefined),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [claim, sheet, rows, header, version],
  )
  const colHead = colHeads ? (c: number) => colHeads[c] : undefined
  return { claim, view, colHead }
}
