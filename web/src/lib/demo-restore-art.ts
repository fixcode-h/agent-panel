/**
 * 演示版「照原画还原」用的示例原画：一张游戏背包界面（SVG 画的，页面里转成像素再跑检测、抠图）。
 * 只给在线演示用，正式包里没有
 */
const W = 1600,
  H = 900
const icons = [
  'gem',
  'sword',
  'potion',
  'scroll',
  'gem',
  'sword',
  'potion',
  'scroll',
  'gem',
  'sword',
  'potion',
  'scroll',
  'gem',
  'coin',
  'potion',
  '',
  '',
  '',
  '',
  '',
]
function iconSvg(k: string, x: number, y: number, s: number, dim?: boolean) {
  const cx = x + s / 2,
    cy = y + s / 2,
    q = s / 2
  const o = dim ? ' opacity="0.35"' : ''
  if (k === 'gem')
    return `<g${o}><polygon points="${cx},${cy - q * 0.9} ${cx + q * 0.7},${cy - q * 0.15} ${cx},${cy + q * 0.9} ${cx - q * 0.7},${cy - q * 0.15}" fill="url(#gGem)" stroke="#bfe3ff" stroke-width="${s / 40}"/><polygon points="${cx},${cy - q * 0.9} ${cx + q * 0.25},${cy - q * 0.15} ${cx},${cy + q * 0.9}" fill="#ffffff" opacity=".25"/></g>`
  if (k === 'sword')
    return `<g${o} transform="rotate(-40 ${cx} ${cy})"><rect x="${cx - q * 0.08}" y="${cy - q * 0.85}" width="${q * 0.16}" height="${q * 1.25}" fill="#d9dde4" stroke="#8a93a3" stroke-width="${s / 60}"/><rect x="${cx - q * 0.35}" y="${cy + q * 0.38}" width="${q * 0.7}" height="${q * 0.12}" fill="#c9a24b"/><rect x="${cx - q * 0.07}" y="${cy + q * 0.5}" width="${q * 0.14}" height="${q * 0.35}" fill="#6b4423"/></g>`
  if (k === 'potion')
    return `<g${o}><rect x="${cx - q * 0.15}" y="${cy - q * 0.8}" width="${q * 0.3}" height="${q * 0.4}" fill="#9cc"/><circle cx="${cx}" cy="${cy + q * 0.15}" r="${q * 0.58}" fill="url(#gPot)" stroke="#bdf" stroke-width="${s / 50}"/></g>`
  if (k === 'scroll')
    return `<g${o}><rect x="${cx - q * 0.45}" y="${cy - q * 0.75}" width="${q * 0.9}" height="${q * 1.5}" rx="${q * 0.1}" fill="#e8d6a8" stroke="#a8874a" stroke-width="${s / 50}"/><rect x="${cx - q * 0.55}" y="${cy - q * 0.85}" width="${q * 1.1}" height="${q * 0.2}" rx="${q * 0.1}" fill="#c9a24b"/><rect x="${cx - q * 0.55}" y="${cy + q * 0.65}" width="${q * 1.1}" height="${q * 0.2}" rx="${q * 0.1}" fill="#c9a24b"/></g>`
  if (k === 'coin')
    return `<g${o}><circle cx="${cx}" cy="${cy}" r="${q * 0.7}" fill="url(#gCoin)" stroke="#7a5a12" stroke-width="${s / 40}"/><circle cx="${cx}" cy="${cy}" r="${q * 0.42}" fill="none" stroke="#fff3" stroke-width="${s / 40}"/></g>`
  return ''
}
const DEFS = `<defs><radialGradient id="gBg" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#3a2552"/><stop offset=".6" stop-color="#1d1330"/><stop offset="1" stop-color="#0c0814"/></radialGradient>
<linearGradient id="gPanel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1f3a"/><stop offset="1" stop-color="#160f22"/></linearGradient>
<linearGradient id="gGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3d27a"/><stop offset=".5" stop-color="#b8892e"/><stop offset="1" stop-color="#f0c96a"/></linearGradient>
<linearGradient id="gGem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a5d8ff"/><stop offset="1" stop-color="#2f6fd6"/></linearGradient>
<radialGradient id="gPot" cx="40%" cy="35%"><stop offset="0" stop-color="#b7f7c8"/><stop offset="1" stop-color="#1f8a4a"/></radialGradient>
<radialGradient id="gCoin" cx="40%" cy="35%"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#c18a1e"/></radialGradient>
<linearGradient id="gBtn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a2f2a"/><stop offset="1" stop-color="#2e1513"/></linearGradient>
<linearGradient id="gBtn2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3348"/><stop offset="1" stop-color="#1e1a28"/></linearGradient></defs>`
export function demoRestoreArt(): string {
  const dim = false,
    shift: Record<string, number> = {}
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${DEFS}
<rect width="${W}" height="${H}" fill="url(#gBg)"/>
${Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 263) % W}" cy="${(i * 137) % H}" r="${(i % 3) + 0.8}" fill="#fff" opacity="${0.15 + (i % 5) * 0.07}"/>`).join('')}
<path d="M0 760 L180 690 L330 740 L520 650 L700 720 L900 640 L1100 710 L1300 660 L1600 740 L1600 900 L0 900Z" fill="#120b1c"/>
<rect x="250" y="130" width="1100" height="640" rx="14" fill="url(#gPanel)" stroke="url(#gGold)" stroke-width="4"/>
<rect x="262" y="142" width="1076" height="616" rx="10" fill="none" stroke="#f3d27a" stroke-opacity=".25"/>
<path d="M230 110 h60 v8 h-52 v52 h-8z" fill="url(#gGold)"/><path d="M1370 110 h-60 v8 h52 v52 h8z" fill="url(#gGold)"/>
<path d="M640 176 h320" stroke="url(#gGold)" stroke-width="2"/>
<text x="800" y="190" text-anchor="middle" font-family="serif" font-size="40" font-weight="700" fill="#f3d27a" stroke="#3b2608" stroke-width="0.5">背 包</text>
<g transform="translate(${shift.close || 0},0)"><circle cx="1310" cy="166" r="20" fill="#3a1f1c" stroke="url(#gGold)" stroke-width="2"/><path d="M1302 158 l16 16 M1318 158 l-16 16" stroke="#f3d27a" stroke-width="3"/></g>
<rect x="990" y="92" width="350" height="36" rx="18" fill="#000" fill-opacity=".45" stroke="#f3d27a" stroke-opacity=".4"/>
${iconSvg('coin', 1000, 96, 28)}<text x="1036" y="118" font-size="20" fill="#f6e7c1" font-family="sans-serif">12,480</text>
${iconSvg('gem', 1180, 96, 28)}<text x="1216" y="118" font-size="20" fill="#cfe6ff" font-family="sans-serif">326</text>`
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c
      const x = 290 + c * 112 + (i === 7 ? shift.slot || 0 : 0),
        y = 230 + r * 112
      const sel = i === 0
      s += `<rect x="${x}" y="${y}" width="100" height="100" rx="8" fill="#0f0a18" stroke="${sel ? '#f3d27a' : '#4b3b66'}" stroke-width="${sel ? 4 : 2}"/>`
      if (sel)
        s += `<rect x="${x - 4}" y="${y - 4}" width="108" height="108" rx="10" fill="none" stroke="#f3d27a" stroke-opacity=".35" stroke-width="6"/>`
      const k = icons[i]
      if (k) {
        s += iconSvg(k, x + 18, y + 14, 64, dim && i === 10)
        s += `<text x="${x + 92}" y="${y + 94}" text-anchor="end" font-size="15" fill="#ddd" font-family="sans-serif">${[3, 1, 12, 5, 99, 2, 4, 1, 7, 1, 24, 3, 1, 6, 8][i] || ''}</text>`
      }
    }
  s += `<rect x="880" y="230" width="430" height="450" rx="10" fill="#0f0a18" fill-opacity=".7" stroke="#4b3b66" stroke-width="2"/>
${iconSvg('gem', 1035, 260, 120)}
<text x="1095" y="432" text-anchor="middle" font-size="30" font-weight="700" fill="#cfe6ff" font-family="sans-serif">星辉宝石</text>
<text x="1095" y="478" text-anchor="middle" font-size="17" fill="#b9b0c9" font-family="sans-serif">蕴含星光之力的宝石，镶嵌后</text>
<text x="1095" y="504" text-anchor="middle" font-size="17" fill="#b9b0c9" font-family="sans-serif">提升魔法攻击 +35。</text>
<rect x="920" y="${600 + (shift.btn || 0)}" width="170" height="56" rx="8" fill="url(#gBtn)" stroke="url(#gGold)" stroke-width="2"/><text x="1005" y="${636 + (shift.btn || 0)}" text-anchor="middle" font-size="22" fill="#f6e7c1" font-family="sans-serif">使用</text>
<rect x="1110" y="600" width="170" height="56" rx="8" fill="url(#gBtn2)" stroke="#6a5a86" stroke-width="2"/><text x="1195" y="636" text-anchor="middle" font-size="22" fill="#cdc3e0" font-family="sans-serif">丢弃</text>
</svg>`
  return s
}
