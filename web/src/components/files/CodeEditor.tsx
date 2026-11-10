import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { t } from '@shared/i18n'
import { highlightLines, htmlSpans, langOf, type Hljs } from '@/lib/file-highlight'
import { HIT_CLASS, HIT_CURRENT_CLASS, type Hit } from '@/lib/file-search'
import { indentEdit, indentUnit } from '@/lib/text-indent'
import type { FileEditing } from './file-edit'

/** 高亮从可见区往上多带这么多行：块注释、多行字符串从上面开始时，可见的这几行颜色也对 */
const CONTEXT = 300

/** 高亮用的库和文件路径：库加载完、换了文件时由 setHl 换掉 */
const hlState = StateField.define<{ hl: Hljs | null; path: string }>({
  create: () => ({ hl: null, path: '' }),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setHl)) return e.value
    return v
  },
})
const setHl = StateEffect.define<{ hl: Hljs | null; path: string }>()

/** 只给看得见的那几十行上色（往上多带 CONTEXT 行一起高亮），打字和滚动时都只算这一小段 */
function hlDecorations(view: EditorView): DecorationSet {
  const { hl, path } = view.state.field(hlState)
  if (!langOf(hl, path)) return Decoration.none
  const doc = view.state.doc
  const first = Math.max(1, doc.lineAt(view.viewport.from).number - CONTEXT)
  const last = doc.lineAt(view.viewport.to).number
  const shownFrom = doc.lineAt(view.viewport.from).number
  const lines = highlightLines(hl, doc.sliceString(doc.line(first).from, doc.line(last).to), path)
  if (!lines) return Decoration.none
  const marks = []
  for (let n = shownFrom; n <= last; n++) {
    const html = lines[n - first]
    if (!html) continue
    const start = doc.line(n).from
    for (const s of htmlSpans(html)) marks.push(Decoration.mark({ class: s.cls }).range(start + s.from, start + s.to))
  }
  return Decoration.set(marks, true)
}

const hlPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = hlDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.startState.field(hlState) !== u.state.field(hlState))
        this.decorations = hlDecorations(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

/** 搜索命中：由外面算好（和阅读时同一套），这里只负责标出来；打字时跟着改动挪位置 */
const setHits = StateEffect.define<{ hits: Hit[]; current: number }>()
const hitField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes)
    for (const e of tr.effects)
      if (e.is(setHits)) {
        const len = tr.state.doc.length
        deco = Decoration.set(
          e.value.hits
            .filter((h) => h.to <= len)
            .map((h, i) =>
              Decoration.mark({ class: i === e.value.current ? HIT_CURRENT_CLASS : HIT_CLASS }).range(h.from, h.to),
            ),
        )
      }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// 和阅读时的代码区字体、行高、内边距一致，切换时不跳；不带行号（行号会随输入变，写起来反而碍眼）
const theme = EditorView.theme({
  '&': { height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
  },
})

/**
 * 编辑区：CodeMirror 6。只排版、只高亮看得见的部分，一百多 KB、整表写在一行的文件打字也跟手
 * （以前是透明输入框叠一层高亮，浏览器每敲一个字都要重排整个输入框，超长行一个字几十毫秒）。
 * 高亮沿用阅读时的 highlight.js 配色；Tab / Shift+Tab 缩进和取消缩进（缩进单位按文件已有的缩进猜），
 * Ctrl/Cmd+S 保存，Ctrl+Z 撤销；带行号打开时把那一行滚到中间、光标放在行首。
 */
export default function CodeEditor({
  ed,
  line,
  path,
  hl,
  hits,
  current,
  seq,
}: {
  ed: FileEditing
  line?: number
  path: string
  hl: Hljs | null
  /** 搜索命中和当前第几处；seq 每按一次上一个 / 下一个加一 */
  hits: Hit[]
  current: number
  seq: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 编辑区自己发出去的最新内容：外面传回来的 ed.text 和它一样就不用回写 */
  const emitted = useRef(ed.text)
  // 回调里要用最新的 ed（保存时读草稿）
  const edRef = useRef(ed)
  edRef.current = ed

  useEffect(() => {
    const unit = indentUnit(ed.text)
    const indent = (outdent: boolean) => (view: EditorView) => {
      const sel = view.state.selection.main
      const r = indentEdit(view.state.doc.toString(), sel.from, sel.to, outdent, unit)
      if (!r) return true
      view.dispatch({
        changes: { from: r.from, to: r.to, insert: r.insert },
        selection: EditorSelection.single(r.selStart, r.selEnd),
        userEvent: 'input.indent',
      })
      return true
    }
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorState.tabSize.of(4),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void edRef.current.save()
            return true
          },
        },
        { key: 'Tab', run: indent(false), shift: indent(true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.contentAttributes.of({ 'aria-label': t('文件内容'), spellcheck: 'false' }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return
        const text = u.state.doc.toString()
        emitted.current = text
        edRef.current.setText(text)
      }),
      hlState,
      hlPlugin,
      hitField,
      theme,
    ]
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: ed.text, extensions }),
    })
    viewRef.current = view
    view.dispatch({ effects: setHl.of({ hl, path }) })
    if (line && line <= view.state.doc.lines) {
      const at = view.state.doc.line(line).from
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    }
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只在挂上时建一次编辑器；之后的内容、高亮、搜索变化都由下面几个 effect 推进去
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外面换了内容（放弃修改后重新读、保存后读回盘上的内容）：整份换掉
  useEffect(() => {
    const view = viewRef.current
    if (!view || ed.text === emitted.current) return
    emitted.current = ed.text
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ed.text } })
  }, [ed.text])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHl.of({ hl, path }) })
  }, [hl, path])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setHits.of({ hits, current }) })
  }, [hits, current])

  // 按了上一个 / 下一个：选中那一处并滚到中间（焦点留在搜索框里，接着按回车还能往下找）
  useEffect(() => {
    const view = viewRef.current
    const h = hits[current]
    if (!view || !h || !seq || h.to > view.state.doc.length) return
    view.dispatch({
      selection: EditorSelection.single(h.from, h.to),
      effects: EditorView.scrollIntoView(h.from, { y: 'center' }),
    })
    // 只跟着按键（seq）走，打字改了命中位置时不跳
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  return <div ref={host} className="h-full w-full font-mono text-footnote [&_.cm-editor]:h-full" />
}
