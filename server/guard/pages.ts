import { t } from '../../shared/i18n.ts'

/**
 * 外网登录页和退出页：面板前端加载之前就要用，所以由服务端直接出一页完整的 HTML，不依赖前端构建。
 * 配色和面板一致，明暗跟着系统（登录前读不到面板里选的主题）。
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

const STYLE = `
:root{color-scheme:light dark;--bg:#faf9f5;--card:#fff;--fg:#141413;--muted:#6b6a65;--line:#e5e3da;--accent:#c96442;--danger:#b4232a}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--card:#30302e;--fg:#f5f4ee;--muted:#a6a39b;--line:#3d3d3a;--accent:#d97757;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 4px;font:600 22px/1.3 Georgia,"Times New Roman",serif}
p{margin:0 0 20px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button,.btn{display:block;width:100%;margin-top:16px;padding:10px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 15px/1.4 inherit;cursor:pointer;text-align:center;text-decoration:none}
.err{margin:12px 0 0;color:var(--danger);font-size:14px}
`

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}

export function loginPage(o: { next: string; error?: string; locked?: boolean }) {
  const error = o.locked ? t('输错次数太多，请过几分钟再试') : (o.error ?? '')
  return page(
    t('登录 Agent 面板'),
    `<h1>${esc(t('登录 Agent 面板'))}</h1><p>${esc(t('这个面板开启了外部访问，请输入访问密码。'))}</p>` +
      `<form method="post" action="/login"><input type="hidden" name="next" value="${esc(o.next)}">` +
      `<label for="pw">${esc(t('访问密码'))}</label>` +
      `<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required ${o.locked ? 'disabled' : ''}>` +
      (error ? `<p class="err" role="alert">${esc(error)}</p>` : '') +
      `<button type="submit" ${o.locked ? 'disabled' : ''}>${esc(t('登录'))}</button></form>`,
  )
}

export function logoutPage() {
  return page(
    t('已退出'),
    `<h1>${esc(t('已退出'))}</h1><p>${esc(t('这个浏览器已经退出登录。'))}</p><a class="btn" href="/login">${esc(t('重新登录'))}</a>`,
  )
}
