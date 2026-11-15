/**
 * 在线演示的网页页签接口（契约 shared/api-contract/web-view.ts）：没有服务端，
 * 本机文件换成浏览器里的 blob 地址（WebFrame 照样加 sandbox、不给同源），外部网址的预检和阅读模式用 shared 里同一份判断，
 * 响应头和网页原文是演示数据。
 */
import { embedVerdict, webUrlOf } from '@shared/web-view/embed'
import { htmlToMarkdown, pageTitle } from '@shared/web-view/reader'
import { WebFileInput, WebProbeInput, WebReaderInput } from '@shared/api-contract/web-view'
import { fail, parse } from './demo-http'

/** 演示里有的 HTML 页面（相对演示项目的路径）：示例内容，不翻译 */
export const DEMO_WEB_PAGES: Record<string, string> = {
  'demo/cart-badge.html': `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>购物车角标 · 示例页</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;background:#faf9f7;color:#222}header{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;background:#fff;border-bottom:1px solid #eee}
.cart{position:relative;font-size:22px}.badge{position:absolute;top:-6px;right:-12px;background:#d4572a;color:#fff;border-radius:999px;font-size:12px;padding:1px 7px}
main{padding:32px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{background:#fff;border:1px solid #eee;border-radius:12px;padding:18px}button{background:#222;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}</style></head>
<body><header><b>Demo Shop</b><span class="cart">🛒<span class="badge" id="n">2</span></span></header>
<main><div class="card"><h3>帆布包</h3><p>¥ 129</p><button onclick="add()">加入购物车</button></div><div class="card"><h3>保温杯</h3><p>¥ 89</p><button onclick="add()">加入购物车</button></div><div class="card"><h3>笔记本</h3><p>¥ 25</p><button onclick="add()">加入购物车</button></div></main>
<script>let n=2;function add(){document.getElementById('n').textContent=String(++n)}</script></body></html>`,
  // archify 画的架构图：本轮产出、回复卡片的缩略预览要有东西看
  '.archify/cart/rag-pipeline.html': `<!doctype html><html><head><meta charset="utf-8"><title>RAG Pipeline Diagram</title>
<style>body{margin:0;font:13px system-ui,sans-serif;background:#f7f7f9}header{display:flex;align-items:center;gap:8px;padding:14px 24px;background:#fff;border-bottom:1px solid #eee;font-weight:600}header i{width:8px;height:8px;border-radius:50%;background:#3b82f6}svg{display:block;margin:28px auto;background:#fff;border:1px solid #eee;border-radius:10px}</style></head>
<body><header><i></i>RAG Pipeline</header><svg width="960" height="340" viewBox="0 0 960 340"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#666"/></marker></defs>
<rect x="20" y="30" width="920" height="290" rx="10" fill="#fffaf2" stroke="#f0c27a" stroke-dasharray="5 4"/><line x1="160" y1="172" x2="190" y2="172" stroke="#666" marker-end="url(#a)"/><line x1="310" y1="172" x2="340" y2="172" stroke="#666" marker-end="url(#a)"/><line x1="460" y1="172" x2="490" y2="172" stroke="#666" marker-end="url(#a)"/><line x1="610" y1="172" x2="640" y2="172" stroke="#666" marker-end="url(#a)"/><line x1="760" y1="172" x2="790" y2="172" stroke="#666" marker-end="url(#a)"/><line x1="550" y1="194" x2="550" y2="258" stroke="#a78bfa" stroke-dasharray="4 3" marker-end="url(#a)"/><line x1="400" y1="150" x2="400" y2="96" stroke="#a78bfa" stroke-dasharray="4 3" marker-end="url(#a)"/><g><rect x="40" y="150" width="120" height="44" rx="6" fill="#e8e8ef" stroke="#999" stroke-width="1"/><text x="100" y="177" text-anchor="middle">User</text></g><g><rect x="190" y="150" width="120" height="44" rx="6" fill="#fde2e2" stroke="#999" stroke-width="1"/><text x="250" y="177" text-anchor="middle">Guardrail</text></g><g><rect x="340" y="150" width="120" height="44" rx="6" fill="#dcf3e6" stroke="#999" stroke-width="1"/><text x="400" y="177" text-anchor="middle">Orchestrator</text></g><g><rect x="490" y="150" width="120" height="44" rx="6" fill="#dcf3e6" stroke="#999" stroke-width="1"/><text x="550" y="177" text-anchor="middle">Retriever</text></g><g><rect x="640" y="150" width="120" height="44" rx="6" fill="#dcf3e6" stroke="#999" stroke-width="1"/><text x="700" y="177" text-anchor="middle">Reranker</text></g><g><rect x="790" y="150" width="120" height="44" rx="6" fill="#fdf0d5" stroke="#999" stroke-width="1"/><text x="850" y="177" text-anchor="middle">LLM</text></g><g><rect x="490" y="260" width="120" height="44" rx="6" fill="#e6e2fb" stroke="#999" stroke-width="1"/><text x="550" y="287" text-anchor="middle">Vector Store</text></g><g><rect x="340" y="50" width="120" height="44" rx="6" fill="#e6e2fb" stroke="#999" stroke-width="1"/><text x="400" y="77" text-anchor="middle">Semantic Cache</text></g></svg></body></html>`,
}

/** 演示里假装取回的响应头：这几个站点和真站点一样不许嵌入 */
const DEMO_HEADERS: Record<string, Record<string, string>> = {
  'github.com': { 'x-frame-options': 'deny', 'content-security-policy': "frame-ancestors 'none'" },
  'www.google.com': { 'x-frame-options': 'SAMEORIGIN' },
  'x.com': { 'content-security-policy': "frame-ancestors 'self'" },
}

const DEMO_ARTICLE = `<html><head><title>tt-a1i/archify: Turn anything into an interactive visual</title></head><body>
<nav><a href="/">GitHub</a></nav><article><h1>Archify</h1>
<p>Turn anything you want to understand, plan, or share into an interactive visual. Describe a system, a problem or a plan, and let your agent draw it as interactive HTML: architecture, flow, sequence, data flow, state, ER, class, tree, timeline and waterfall diagrams, or a one-page explainer.</p>
<h2>Install, then describe your idea</h2><p>Works with Cursor, Claude Code, Codex CLI, and OpenCode. Send this to your agent:</p>
<pre><code>Use Archify to diagram a web request: Browser calls the API,
the API checks Redis, and a cache miss queries PostgreSQL
and fills the cache.</code></pre>
<h2>Ask a question, get a one-page answer</h2><p>Not every answer is one diagram. Ask your agent to answer as a page and Archify builds an explainer: the conclusion first, then one panel per question, with tables, steps, charts, code and validated diagrams.</p>
</article><footer>© GitHub</footer></body></html>`

// 模块状态：缓存，同一个文件只建一次 blob 地址；刷新页面就没了，再建就行
const blobs = new Map<string, string>()

const typeOf = (p: string) => (/\.svg$/i.test(p) ? 'image/svg+xml' : 'text/html;charset=utf-8')

/** text：演示项目里文件的内容（演示后端的 DEMO_CONTENTS 等），没有这个文件时给 undefined */
export function demoWebView(url: string, body: unknown, text: (path: string) => string | undefined) {
  const action = url.split('?')[0].split('/').filter(Boolean)[1]
  if (action === 'file') {
    const { path } = parse(WebFileInput, body)
    // 演示项目的路径是相对的；回复里写的绝对路径按演示项目目录剥掉前缀
    const rel = path.replace(/^.*?demo-shop\//, '').replace(/^\.?\//, '')
    const content = DEMO_WEB_PAGES[rel] ?? text(rel)
    if (content === undefined) return fail(`文件不存在：${path}`)
    let src = blobs.get(rel)
    if (!src) {
      src = URL.createObjectURL(new Blob([content], { type: typeOf(rel) }))
      blobs.set(rel, src)
    }
    return { url: src, title: pageTitle(content) || (rel.split('/').pop() ?? rel), size: new Blob([content]).size }
  }
  if (action === 'probe') {
    const u = webUrlOf(parse(WebProbeInput, body).url)
    if (!u) return fail('只能打开 http 或 https 的网址')
    const h = DEMO_HEADERS[u.hostname] ?? {}
    return { ...embedVerdict({ get: (k) => h[k.toLowerCase()] ?? null }), finalUrl: u.href }
  }
  if (action === 'reader') {
    const u = webUrlOf(parse(WebReaderInput, body).url)
    if (!u) return fail('只能打开 http 或 https 的网址')
    return { title: pageTitle(DEMO_ARTICLE), site: u.hostname, markdown: htmlToMarkdown(DEMO_ARTICLE, u.href) }
  }
  return fail('不支持的操作', 404)
}
