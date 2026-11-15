import { t } from '@shared/i18n'
import { WebFrame } from '@/components/ui/web-frame'

/** 设置 → 组件里网页框的示例页（示例内容用英文写死，不进文案表）：同一段 HTML 一份缩略图、一份整页 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#faf9f7;color:#222}
header{padding:16px 28px;background:#fff;border-bottom:1px solid #eee;font-weight:600}
main{padding:24px 28px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:#fff;border:1px solid #eee;border-radius:12px;padding:16px}
button{background:#222;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer}
</style></head><body><header>Demo Shop</header><main>
<div class="card"><b>Canvas bag</b><p>¥ 129</p><button onclick="this.textContent='Added'">Add to cart</button></div>
<div class="card"><b>Thermos</b><p>¥ 89</p><button onclick="this.textContent='Added'">Add to cart</button></div>
<div class="card"><b>Notebook</b><p>¥ 25</p><button onclick="this.textContent='Added'">Add to cart</button></div>
</main></body></html>`

export function WebFrameSpecimen() {
  return (
    <div className="flex w-full flex-wrap items-start gap-4">
      <div className="flex w-56 flex-col gap-1.5">
        <span className="text-footnote text-subtle">{t('缩略图（mode="thumb"）')}</span>
        <WebFrame target={{ kind: 'html', html: PAGE }} mode="thumb" className="h-36 rounded-lg border" />
      </div>
      <div className="flex min-w-[18rem] flex-1 flex-col gap-1.5">
        <span className="text-footnote text-subtle">{t('整页（mode="full"），页面关在沙箱里')}</span>
        <div className="flex h-56 flex-col overflow-hidden rounded-lg border">
          <WebFrame target={{ kind: 'html', html: PAGE }} title={t('示例网页')} />
        </div>
      </div>
    </div>
  )
}
