import { useState } from 'react'
import { t } from '@shared/i18n'
import { HtmlCard } from '@/components/ui/html-card'
import { MenuItem } from '@/components/ui/menu'
import { OutputRow, OutputsCard } from '@/components/ui/outputs-card'

/** 样张里的缩略预览：画一张示意的网页（标题条、几个方块和连线），不加载真的文件 */
function MockPage() {
  return (
    <div className="flex h-full flex-col gap-2 bg-bg p-3">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="h-1.5 w-20 rounded bg-fg/30" />
        <span className="flex-1" />
        <span className="h-3 w-10 rounded bg-fg/80" />
      </div>
      <div className="relative flex flex-1 items-center justify-center gap-3 rounded-md border border-dashed border-warning/50 bg-warning/5">
        {['bg-peer/25', 'bg-run/25', 'bg-success/25', 'bg-warning/30'].map((c) => (
          <span key={c} className={`h-6 w-12 rounded border border-fg/15 ${c}`} />
        ))}
      </div>
    </div>
  )
}

/**
 * 设置 → 组件里的 HTML 卡片和本轮产出样张：大卡片、正在右栏显示的大卡片、一行的小卡片，和本轮产出卡片（示例数据不翻译）。
 * 点卡片在样张里切换「正在显示」，好看清描边
 */
export function HtmlCardSpecimen() {
  const [active, setActive] = useState('rag')
  const menu = (
    <>
      <MenuItem>{t('复制路径')}</MenuItem>
      <MenuItem>{t('在文件浏览里显示')}</MenuItem>
    </>
  )
  return (
    <div className="flex w-full max-w-3xl flex-col gap-3">
      <HtmlCard
        title="RAG Pipeline Diagram"
        name="rag-pipeline.html"
        size={851_000}
        preview={<MockPage />}
        active={active === 'rag'}
        onOpen={() => setActive('rag')}
        onNewWindow={() => {}}
        menu={menu}
      />
      <HtmlCard
        variant="small"
        title="Agent Tool Call Workflow"
        name="agent-tool-call.html"
        size={626_000}
        active={active === 'tool'}
        onOpen={() => setActive('tool')}
        onNewWindow={() => {}}
        menu={menu}
      />
      <OutputsCard
        note={t('这一轮新建了 {n} 个能直接看的文件', { n: 4 })}
        aside={t('上一轮的在「本对话改动」里')}
        cards={
          <>
            <HtmlCard
              title="购物车角标 · 示例页"
              name="demo/cart-badge.html"
              size={18_400}
              preview={<MockPage />}
              active={active === 'badge'}
              onOpen={() => setActive('badge')}
            />
            <HtmlCard
              title="RAG Pipeline Diagram"
              name=".archify/cart/rag-pipeline.html"
              size={851_000}
              preview={<MockPage />}
              active={active === 'rag2'}
              onOpen={() => setActive('rag2')}
            />
          </>
        }
      >
        <OutputRow path="docs/角标刷新问题-排查记录.md" status="added" size={4_100} onPreview={() => {}} />
        <OutputRow path="ui-shots/cart-badge-after.png" status="modified" size={98_300} onPreview={() => {}} />
      </OutputsCard>
    </div>
  )
}
