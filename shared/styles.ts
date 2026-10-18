import type { PromptCategory, SavedStyle } from './design.ts'

/**
 * 内置风格库：游戏 UI 和网页 UI 各一批市面上常见、好用的整体美术风格，随程序一起打包。
 * 和用户自己存的风格一起出现在风格库里（只读，可以复制成自己的再改）：
 * 新设计还没定风格时 AI 会从里面挑几个作为选项，设计里能直接套用，项目的美术提示词也能从这里导入。
 *
 * 每个风格：summary 是给人看的中文说明；en 是发给 AI 的完整英文风格描述（画风、配色、材质、光影、形状、字体气质）；
 * prompts 是拆开的要点（导入项目提示词时用），avoid 是不想要的东西。
 */

const AT = '2026-01-01T00:00:00.000Z'
const p = (category: PromptCategory, zh: string, en: string) => ({ category, zh, en })

type Def = {
  slug: string
  name: string
  summary: string
  en: string
  prompts: ReturnType<typeof p>[]
}

const make = (kind: 'game' | 'web', defs: Def[]): SavedStyle[] =>
  defs.map((d) => ({
    id: `builtin-${kind}-${d.slug}`,
    name: d.name,
    kind,
    summary: d.summary,
    en: d.en,
    prompts: d.prompts,
    builtin: true,
    createdAt: AT,
    updatedAt: AT,
  }))

const GAME = make('game', [
  {
    slug: 'dark-fantasy',
    name: '暗黑奇幻·石刻暗金',
    summary: '深色石刻底框配做旧暗金描边，幽蓝符文微光，厚重神秘，像《暗黑破坏神》《艾尔登法环》的界面。',
    en: 'Dark fantasy game UI in the spirit of Diablo and Elden Ring: heavy carved dark stone and blackened iron panels, aged antique gold trim and filigree corners, subtle engraved runes with a faint cold blue glow, deep charcoal and near-black base colors with muted gold and blood-red accents, worn scratched surfaces, soft rim lighting from above, ornate but restrained, serious mysterious mood, serif display lettering feel.',
    prompts: [
      p('style', '暗黑奇幻', 'dark fantasy game UI'),
      p('color', '炭黑底、做旧暗金、少量血红点缀', 'charcoal black base, aged antique gold, small blood-red accents'),
      p('material', '石刻底框、黑铁、金属花纹边角', 'carved stone frames, blackened iron, filigree metal corners'),
      p('light', '顶部边缘光、符文幽蓝微光', 'soft top rim light, faint cold blue rune glow'),
      p('layout', '厚重对称的边框，四角有装饰', 'heavy symmetric frames with ornamented corners'),
      p('avoid', '亮色、卡通感、扁平色块', 'bright colors, cartoon look, flat color blocks'),
    ],
  },
  {
    slug: 'medieval-parchment',
    name: '中世纪羊皮纸与木铁',
    summary: '羊皮纸、旧木板、铆钉铁件和蜡封，暖棕色调，像策略和 RPG 里的任务卷轴与背包。',
    en: 'Medieval fantasy RPG UI: aged parchment paper panels with burnt edges, dark oak wood planks, riveted wrought-iron brackets and straps, red wax seals, leather bindings, warm sepia browns and cream with deep red and tarnished brass accents, hand-inked decorative borders and illuminated-manuscript flourishes, soft warm candlelight, slightly worn and stained surfaces, calligraphic serif lettering feel.',
    prompts: [
      p('style', '中世纪 RPG 界面', 'medieval fantasy RPG UI'),
      p('color', '暖棕、米白、深红、黄铜', 'warm sepia brown, cream, deep red, tarnished brass'),
      p('material', '羊皮纸、橡木、铆钉铁件、皮革、蜡封', 'parchment, oak wood, riveted iron, leather, wax seal'),
      p('light', '柔和的烛光暖光', 'soft warm candlelight'),
      p('layout', '卷轴和木牌式的面板，手绘装饰边', 'scroll and wooden plaque panels with hand-inked borders'),
      p('avoid', '金属冷色、霓虹、现代感', 'cold metal, neon, modern look'),
    ],
  },
  {
    slug: 'steampunk',
    name: '蒸汽朋克·黄铜齿轮',
    summary: '黄铜、铜管、齿轮、压力表和皮带，暖金属色加蒸汽白雾，机械复古感。',
    en: 'Steampunk game UI: polished and oxidized brass and copper panels, exposed gears and cogs, rivets, pipes and pressure gauges, leather straps and stitched leather, glass dials with amber backlight, dark walnut wood inlays, warm copper gold and deep brown palette with verdigris green accents, soft steam haze, Victorian engraved ornament, mechanical retro-futuristic mood, subtle scratches and patina.',
    prompts: [
      p('style', '蒸汽朋克', 'steampunk game UI'),
      p('color', '黄铜金、铜红、深棕、铜绿点缀', 'brass gold, copper red, deep brown, verdigris accents'),
      p('material', '黄铜铜管、齿轮、铆钉、皮革、玻璃表盘', 'brass and copper, gears, rivets, leather, glass dials'),
      p('light', '琥珀色背光、蒸汽雾气', 'amber backlight, soft steam haze'),
      p('layout', '带齿轮和仪表的机械面板', 'mechanical panels with gears and gauges'),
      p('avoid', '塑料感、霓虹、光滑扁平', 'plastic look, neon, smooth flat surfaces'),
    ],
  },
  {
    slug: 'cyberpunk',
    name: '赛博朋克·霓虹',
    summary: '深紫黑底配品红、青色霓虹描边，切角面板、故障纹和全息光，像《赛博朋克 2077》。',
    en: 'Cyberpunk game UI in the spirit of Cyberpunk 2077: near-black deep purple base, hot magenta, electric cyan and acid yellow neon outlines and glows, angular chamfered panels with cut corners, thin glowing circuit lines, scanlines, glitch and chromatic aberration accents, translucent dark glass with bloom, bold condensed techno lettering feel, gritty high-tech low-life mood.',
    prompts: [
      p('style', '赛博朋克', 'cyberpunk game UI'),
      p('color', '紫黑底、品红、青色、酸性黄霓虹', 'near-black purple base, magenta, cyan, acid yellow neon'),
      p('material', '半透明黑玻璃、发光线路', 'translucent dark glass, glowing circuit lines'),
      p('light', '霓虹辉光、泛光、扫描线', 'neon glow, bloom, scanlines'),
      p('layout', '切角多边形面板、细线分割', 'chamfered angular panels, thin divider lines'),
      p('avoid', '圆润可爱、暖色木质、手绘', 'cute rounded shapes, warm wood, hand-painted look'),
    ],
  },
  {
    slug: 'scifi-hologram',
    name: '科幻全息·HUD',
    summary: '深蓝底、青色发光线框和半透明玻璃面板，数据读数和刻度，像《战争机器》《命运》《光环》的 HUD。',
    en: 'Sci-fi holographic HUD game UI: deep navy and black base, cyan and ice-blue glowing thin wireframes, translucent glass panels with soft blur, fine tick marks, data readouts, hexagon and segmented-ring motifs, small corner brackets, subtle scanline and grid texture, clean precise geometry, soft bloom glow, minimal and futuristic, light technical sans-serif lettering feel.',
    prompts: [
      p('style', '科幻全息 HUD', 'sci-fi holographic HUD'),
      p('color', '深蓝黑底、青色和冰蓝发光', 'deep navy black base, cyan and ice-blue glow'),
      p('material', '半透明玻璃、发光细线框', 'translucent glass, thin glowing wireframes'),
      p('light', '柔和泛光、微弱网格和扫描线', 'soft bloom, faint grid and scanlines'),
      p('layout', '细线分割、四角括号、刻度和六边形', 'thin dividers, corner brackets, tick marks, hexagons'),
      p('avoid', '厚重装饰、暖色、做旧质感', 'heavy ornament, warm colors, worn textures'),
    ],
  },
  {
    slug: 'anime-elegant',
    name: '二次元·清新华丽',
    summary: '明亮的白金配色，柔和渐变、精致描边和星星花瓣装饰，像《原神》《崩坏》的洁净华丽界面。',
    en: 'Polished anime gacha-game UI in the spirit of Genshin Impact: clean bright panels in cream white and soft pastel gradients, thin elegant gold and light-brown outlines, delicate ornamental corners, small star, petal and crest motifs, soft inner glow and gentle drop shadows, smooth rounded rectangles, high-end mobile RPG feel, crisp vector-like rendering, light friendly mood, refined rounded lettering feel.',
    prompts: [
      p('style', '二次元手游界面，精致洁净', 'polished anime gacha mobile UI'),
      p('color', '奶白、柔和渐变粉彩、浅金描边', 'cream white, soft pastel gradients, light gold outlines'),
      p('material', '干净的面板、细金边、柔和内发光', 'clean panels, thin gold edges, soft inner glow'),
      p('light', '柔和光晕、轻投影', 'soft glow, gentle drop shadow'),
      p('layout', '圆角矩形，角落有星星和花瓣小装饰', 'rounded rectangles with small star and petal corner ornaments'),
      p('avoid', '做旧脏污、暗黑、粗糙质感', 'grunge, dark mood, rough texture'),
    ],
  },
  {
    slug: 'cartoon-chunky',
    name: '卡通手绘·圆润粗描边',
    summary: '饱和明亮的色块，圆润厚实的深色粗描边和高光，Q 弹可爱，像《皇室战争》《部落冲突》。',
    en: 'Chunky cartoon mobile-game UI in the spirit of Clash Royale: saturated bright candy colors, thick dark rounded outlines, bold glossy highlights on the top edge of every shape, strong bottom bevel shadow giving a puffy 3D button feel, chunky rounded panels, simple clear shapes, playful and energetic, hand-painted cel shading, bouncy friendly mood, heavy rounded display lettering with outline feel.',
    prompts: [
      p('style', '卡通手游界面，Q 弹厚实', 'chunky cartoon mobile game UI'),
      p('color', '高饱和糖果色、深色描边', 'highly saturated candy colors, dark outlines'),
      p('material', '圆润厚实的面板，顶部高光、底部厚阴影', 'puffy panels, top highlight, thick bottom bevel shadow'),
      p('light', '手绘赛璐璐明暗', 'hand-painted cel shading'),
      p('layout', '大圆角、形状简单清楚', 'big rounded corners, simple clear shapes'),
      p('avoid', '写实质感、细碎纹理、暗淡色彩', 'realistic textures, fine detail noise, dull colors'),
    ],
  },
  {
    slug: 'pixel-retro',
    name: '像素复古·16 位',
    summary: '16 位像素风，硬边块面、无抗锯齿、有限调色板，经典 RPG 和街机味道。',
    en: 'Retro 16-bit pixel art game UI: crisp hard-edged pixels with no anti-aliasing or blur, limited palette of about 16 colors, chunky 1-2 pixel outlines, stepped dithering for gradients, beveled pixel panels and buttons, classic JRPG dialog-box blue and white frames, small pixel icons and decorative corners, flat shading, nostalgic arcade mood, bitmap pixel lettering feel.',
    prompts: [
      p('style', '16 位像素风', '16-bit pixel art game UI'),
      p('color', '有限调色板（约 16 色）', 'limited palette of about 16 colors'),
      p('material', '像素斜面面板、阶梯抖动渐变', 'pixel beveled panels, stepped dithering gradients'),
      p('light', '平涂，没有柔和发光', 'flat shading, no soft glow'),
      p('layout', '1~2 像素粗描边，对话框式边框', '1-2 pixel outlines, dialog-box style frames'),
      p('avoid', '抗锯齿、模糊、渐变平滑、写实', 'anti-aliasing, blur, smooth gradients, realism'),
    ],
  },
  {
    slug: 'ink-wash',
    name: '国风水墨',
    summary: '宣纸质感加水墨笔触，黑白灰为主点缀朱砂红，留白、云纹和印章，雅致清透。',
    en: 'Chinese ink wash game UI: warm rice-paper texture panels, expressive ink brush strokes and soft ink gradients, mostly black white and grey with small vermilion red seal-stamp accents, generous negative space, subtle cloud and wave patterns, thin brush-drawn borders, hand-painted calligraphic flourishes, translucent wash layers, elegant quiet and airy mood, brush calligraphy lettering feel.',
    prompts: [
      p('style', '国风水墨', 'Chinese ink wash painting game UI'),
      p('color', '黑白灰，朱砂红印章点缀', 'black white grey with vermilion seal accents'),
      p('material', '宣纸纹理、水墨渐变和笔触', 'rice paper texture, ink gradients and brush strokes'),
      p('light', '柔和通透，没有强光', 'soft and airy, no harsh lighting'),
      p(
        'layout',
        '大量留白，云纹和水纹装饰，毛笔画的细边',
        'generous negative space, cloud and wave patterns, brush-drawn thin borders',
      ),
      p('avoid', '霓虹、金属质感、高饱和色', 'neon, metallic surfaces, highly saturated colors'),
    ],
  },
  {
    slug: 'xianxia-gold-jade',
    name: '东方仙侠·鎏金玉石',
    summary: '白玉、青玉和鎏金镶边，云纹、祥瑞图案和流光，华美仙气，像国风仙侠手游。',
    en: 'Eastern xianxia fantasy game UI: white and celadon jade panels with gilded gold edges, carved cloud scroll and auspicious pattern ornaments, lotus and phoenix motifs, flowing silk ribbon accents, soft pearl-white glow and drifting light particles, deep teal-ink and imperial vermilion with warm gold highlights, ornate yet graceful, ethereal immortal-realm mood, traditional calligraphic title lettering feel.',
    prompts: [
      p('style', '东方仙侠，国风华美', 'eastern xianxia fantasy game UI'),
      p('color', '白玉青玉、鎏金、朱红、深青墨色', 'white and celadon jade, gilded gold, vermilion, deep teal ink'),
      p('material', '玉石、鎏金镶边、丝绸飘带', 'jade, gilded gold edging, silk ribbons'),
      p('light', '柔和珠光、飘散光点', 'soft pearl glow, drifting light particles'),
      p(
        'layout',
        '云纹、莲花和凤凰装饰，对称端庄',
        'cloud scrolls, lotus and phoenix ornaments, symmetric and graceful',
      ),
      p('avoid', '西式哥特、霓虹、做旧脏污', 'western gothic, neon, grungy wear'),
    ],
  },
  {
    slug: 'post-apocalypse',
    name: '末日废土·锈蚀',
    summary: '锈铁、胶带、粗糙帆布和手写标记，灰黄脏污，像《辐射》《疯狂的麦克斯》的拼凑感。',
    en: 'Post-apocalyptic wasteland game UI: rusted scrap metal plates, riveted patches, duct tape, rough canvas and cardboard, spray-paint stencil markings and hand-scrawled notes, dusty desaturated olive, sand yellow and rust orange palette with faded warning-sign red, heavy wear, scratches, stains and peeling paint, harsh flat lighting, improvised jury-rigged look, gritty survival mood, stencil lettering feel.',
    prompts: [
      p('style', '末日废土', 'post-apocalyptic wasteland game UI'),
      p('color', '灰橄榄、沙黄、锈橙、褪色警示红', 'dusty olive, sand yellow, rust orange, faded warning red'),
      p(
        'material',
        '锈蚀铁板、胶带、帆布、纸板、喷漆模板',
        'rusted scrap metal, duct tape, canvas, cardboard, stencil spray paint',
      ),
      p('light', '粗糙的平光，没有柔和发光', 'harsh flat lighting, no soft glow'),
      p('layout', '拼凑感的面板，铆钉补丁，手写标记', 'jury-rigged panels, riveted patches, hand-scrawled marks'),
      p('avoid', '干净光滑、高饱和色、精致装饰', 'clean smooth surfaces, saturated colors, fine ornament'),
    ],
  },
  {
    slug: 'gothic-horror',
    name: '哥特恐怖·暗红',
    summary: '黑色天鹅绒、尖拱花窗、暗红和骨白，哥特装饰与阴冷雾气，像《血源诅咒》。',
    en: 'Gothic horror game UI in the spirit of Bloodborne: black velvet and cracked bone-white panels, pointed arches and tracery like cathedral windows, thorny wrought-iron filigree, deep crimson and oxblood accents on near-black with bone and ash grey, cold fog and dim moonlight, faint candle glow, aged cracks and grime, elegant macabre mood, sharp angular gothic blackletter lettering feel.',
    prompts: [
      p('style', '哥特恐怖', 'gothic horror game UI'),
      p('color', '近黑底、暗红、骨白、灰烬灰', 'near-black base, crimson oxblood, bone white, ash grey'),
      p(
        'material',
        '黑色天鹅绒、开裂的骨白石、荆棘铁艺',
        'black velvet, cracked bone-white stone, thorny wrought iron',
      ),
      p('light', '阴冷雾气、昏暗月光、微弱烛光', 'cold fog, dim moonlight, faint candle glow'),
      p('layout', '尖拱和教堂花窗式的框，对称', 'pointed arch and cathedral tracery frames, symmetric'),
      p('avoid', '明亮欢快、卡通、霓虹', 'bright cheerful colors, cartoon look, neon'),
    ],
  },
  {
    slug: 'flat-minimal-game',
    name: '扁平极简·手游',
    summary: '干净的扁平色块和细微阴影，大圆角，少量渐变，清爽易读，适合休闲和工具类手游。',
    en: 'Flat minimalist casual mobile game UI: clean flat color panels with large rounded corners, a restrained palette of 3-4 harmonious colors with one vivid accent, very subtle soft shadows, simple geometric icons with consistent stroke weight, generous spacing, no textures, maximum readability, light friendly modern mood, rounded geometric sans-serif lettering feel.',
    prompts: [
      p('style', '扁平极简手游界面', 'flat minimalist casual mobile game UI'),
      p('color', '3~4 个协调的颜色加一个鲜明强调色', '3-4 harmonious colors plus one vivid accent'),
      p('material', '干净的平涂色块，不用纹理', 'clean flat color fills, no textures'),
      p('light', '很淡的柔和投影', 'very subtle soft shadows'),
      p(
        'layout',
        '大圆角、留白充足、图标线条粗细一致',
        'large rounded corners, generous spacing, consistent icon stroke',
      ),
      p('avoid', '复杂纹理、厚重装饰、写实质感', 'complex textures, heavy ornament, realism'),
    ],
  },
])

const WEB = make('web', [
  {
    slug: 'saas-minimal',
    name: '简约科技·SaaS',
    summary: '大量留白、细线条、中性灰加一个蓝紫强调色，克制利落，像 Linear、Vercel 的产品页。',
    en: 'Minimal modern SaaS web design in the spirit of Linear and Vercel: generous whitespace, near-white background with very light grey surfaces, thin 1px hairline borders, one restrained blue-violet accent color with a subtle gradient used sparingly, crisp medium-radius corners, extremely soft shadows, clean grid layout, large confident sans-serif headings with tight tracking, precise and calm professional mood.',
    prompts: [
      p('style', '简约科技 SaaS 网页', 'minimal modern SaaS web design'),
      p(
        'color',
        '近白底、浅灰面板、一个蓝紫强调色',
        'near-white background, light grey surfaces, one blue-violet accent',
      ),
      p('material', '1px 细边框，很淡的阴影', '1px hairline borders, very soft shadows'),
      p('layout', '大量留白，清晰的网格，大标题', 'generous whitespace, clean grid, large headings'),
      p('avoid', '高饱和多色、厚重阴影、装饰性插画', 'many saturated colors, heavy shadows, decorative illustration'),
    ],
  },
  {
    slug: 'dark-devtool',
    name: '深色·开发者工具',
    summary: '近黑底、灰阶层次和荧光绿 / 蓝强调，等宽字体和代码块，像 GitHub、终端类产品。',
    en: 'Dark mode developer-tool web design: near-black background (#0d1117 feel) with layered dark grey surfaces, subtle 1px borders in slightly lighter grey, one neon accent (electric green or blue) for primary actions and links, monospace type for code and small labels paired with a clean sans-serif, code blocks with syntax-highlight colors, small radius corners, dense but organized information layout, focused technical mood.',
    prompts: [
      p('style', '深色开发者工具网页', 'dark mode developer tool web design'),
      p(
        'color',
        '近黑底、灰阶分层、荧光绿或蓝强调色',
        'near-black background, layered greys, neon green or blue accent',
      ),
      p('material', '浅灰细边框，小圆角', 'light grey hairline borders, small radius corners'),
      p('layout', '信息紧凑有序，等宽字体和代码块', 'dense organized layout, monospace type and code blocks'),
      p('avoid', '大面积亮色、柔和可爱、衬线字体', 'large bright areas, cute soft shapes, serif type'),
    ],
  },
  {
    slug: 'glassmorphism',
    name: '玻璃拟态·毛玻璃',
    summary: '半透明磨砂玻璃卡片叠在鲜艳的渐变背景上，细白边和柔和光晕，通透轻盈。',
    en: 'Glassmorphism web design: frosted translucent glass cards with strong background blur floating over a vivid mesh gradient background (violet, pink, blue, teal), thin semi-transparent white borders and subtle inner highlight on the top edge, soft diffuse colored shadows, large rounded corners, layered depth, white text with high contrast over the glass, airy light futuristic mood.',
    prompts: [
      p('style', '玻璃拟态网页', 'glassmorphism web design'),
      p('color', '紫、粉、蓝、青的鲜艳渐变背景', 'vivid violet pink blue teal mesh gradient background'),
      p(
        'material',
        '磨砂半透明玻璃卡片，半透明白细边',
        'frosted translucent glass cards, thin semi-transparent white borders',
      ),
      p('light', '柔和的彩色弥散阴影，顶部内高光', 'soft diffuse colored shadows, top inner highlight'),
      p('layout', '大圆角，卡片分层叠放', 'large rounded corners, layered stacked cards'),
      p('avoid', '不透明厚重色块、锐利硬阴影', 'opaque heavy color blocks, sharp hard shadows'),
    ],
  },
  {
    slug: 'neumorphism',
    name: '新拟物·柔和凸凹',
    summary: '同色系的柔和凸起和凹陷，双向柔光阴影，像从底板上捏出来的按钮和卡片。',
    en: 'Neumorphism soft UI web design: monochrome light grey-blue background with elements extruded from it, dual soft shadows (light from the top-left, dark from the bottom-right) creating gentle raised and pressed-in surfaces, buttons and cards in the same color as the background, large rounded corners, very low contrast, one muted accent color for active states, calm tactile minimalist mood, rounded sans-serif lettering.',
    prompts: [
      p('style', '新拟物柔和 UI', 'neumorphism soft UI'),
      p(
        'color',
        '浅灰蓝单色底，一个柔和强调色表示选中',
        'monochrome light grey-blue, one muted accent for active states',
      ),
      p('material', '和底板同色的凸起与凹陷', 'raised and pressed-in surfaces in the background color'),
      p('light', '左上亮、右下暗的双向柔和阴影', 'dual soft shadows, light top-left, dark bottom-right'),
      p('layout', '大圆角，低对比，大量留白', 'large rounded corners, low contrast, generous spacing'),
      p('avoid', '硬边描边、高对比、强烈颜色', 'hard outlines, high contrast, strong colors'),
    ],
  },
  {
    slug: 'neo-brutalism',
    name: '新粗野主义',
    summary: '粗黑描边、硬阴影、高饱和平涂色块和大号粗体字，直接、有个性。',
    en: 'Neo-brutalist web design: thick solid black outlines on every element, hard offset drop shadows with no blur, flat high-saturation color blocks (lemon yellow, hot pink, mint, electric blue) on an off-white or cream background, oversized bold grotesque headings, slightly rotated stickers and badges, raw grid with visible structure, playful confident loud mood, no gradients.',
    prompts: [
      p('style', '新粗野主义网页', 'neo-brutalist web design'),
      p('color', '柠檬黄、亮粉、薄荷绿、电光蓝，米白底', 'lemon yellow, hot pink, mint, electric blue on off-white'),
      p('material', '粗黑描边、无模糊的硬偏移阴影', 'thick black outlines, hard offset shadows without blur'),
      p(
        'layout',
        '外露的网格，大号粗体标题，略微倾斜的贴纸',
        'visible raw grid, oversized bold headings, slightly rotated stickers',
      ),
      p('avoid', '渐变、柔和阴影、细线条、低对比', 'gradients, soft shadows, thin lines, low contrast'),
    ],
  },
  {
    slug: 'editorial-warm',
    name: '温暖编辑感·纸张',
    summary: '米色纸张底、衬线大标题、暖橙或赭红强调，排版讲究，像杂志和 Anthropic 风格的阅读页。',
    en: 'Warm editorial web design: cream and beige paper-textured background, elegant high-contrast serif headings paired with a clean sans-serif for body text, generous line spacing and wide margins, terracotta or warm orange accent, thin rules and small caps labels, soft rounded cards with very gentle shadows, hand-drawn line illustrations, thoughtful calm literary magazine mood.',
    prompts: [
      p('style', '温暖编辑感杂志网页', 'warm editorial magazine web design'),
      p('color', '米色纸张底，赤陶橙或赭红强调', 'cream paper background, terracotta or warm orange accent'),
      p('material', '微弱的纸张纹理，细分隔线', 'faint paper texture, thin rules'),
      p('layout', '衬线大标题，宽松行距和页边距', 'large serif headings, generous line spacing and margins'),
      p('avoid', '冷色霓虹、粗黑描边、拥挤排版', 'cold neon, thick black outlines, crowded layout'),
    ],
  },
  {
    slug: 'bento-grid',
    name: 'Bento 卡片网格',
    summary: '大小不一的圆角卡片拼成整齐的便当格，每格一个功能点，像苹果发布会的页面。',
    en: 'Bento grid web design in the spirit of Apple product pages: modular rounded cards of different sizes tiled into a tidy grid with consistent gaps, each card focused on one feature with a short headline and a clean visual or product render, soft neutral backgrounds with a few cards in bold gradient or dark fill, very large corner radius, subtle shadows, crisp system sans-serif typography, premium clean confident mood.',
    prompts: [
      p('style', 'Bento 便当格网页', 'bento grid web design'),
      p('color', '柔和中性底，少数卡片用渐变或深色', 'soft neutral background, a few cards in gradient or dark fill'),
      p('material', '大圆角卡片，很淡的阴影', 'large radius cards, very subtle shadows'),
      p(
        'layout',
        '大小不同的卡片整齐拼成网格，间距一致，每张卡片一个重点',
        'varied card sizes in a tidy grid, consistent gaps, one point per card',
      ),
      p('avoid', '杂乱无序、细碎装饰、粗描边', 'disorder, fine decoration, thick outlines'),
    ],
  },
  {
    slug: 'swiss-typographic',
    name: '瑞士风·黑白排版',
    summary: '无衬线大字、严格网格、黑白加一个鲜明红色，以排版取胜，克制有力。',
    en: 'Swiss International Typographic Style web design: strict modular grid, huge bold neo-grotesque sans-serif headlines (Helvetica-like) set flush left, black and white with a single vivid signal red accent, thick horizontal rules, asymmetric balanced layout, tiny precise captions, abundant whitespace, photography in high-contrast black and white, objective rational powerful mood, no decoration.',
    prompts: [
      p('style', '瑞士国际主义排版风网页', 'Swiss International Typographic Style web design'),
      p('color', '黑白加一个鲜明的信号红', 'black and white with one vivid signal red'),
      p('material', '粗横线，高反差黑白照片', 'thick horizontal rules, high-contrast black and white photography'),
      p(
        'layout',
        '严格网格，左对齐的超大无衬线标题，不对称平衡',
        'strict grid, huge flush-left sans-serif headlines, asymmetric balance',
      ),
      p('avoid', '装饰、渐变、阴影、圆角', 'decoration, gradients, shadows, rounded corners'),
    ],
  },
  {
    slug: 'aurora-gradient',
    name: '极光渐变·流体',
    summary: '柔和弥散的多色流体渐变背景，白色卡片和大圆角，现代轻盈，像 Stripe 的页面。',
    en: 'Aurora mesh gradient web design in the spirit of Stripe: soft flowing blurred gradient blobs (indigo, magenta, coral, cyan) as hero backgrounds and accents, clean white content cards with large rounded corners and delicate shadows, crisp modern sans-serif typography with strong hierarchy, gradient text on key words, smooth pill-shaped buttons, light airy optimistic premium mood.',
    prompts: [
      p('style', '极光渐变网页', 'aurora mesh gradient web design'),
      p('color', '靛蓝、洋红、珊瑚、青色的柔和流体渐变', 'soft flowing indigo, magenta, coral and cyan gradients'),
      p(
        'material',
        '白色卡片、大圆角、细腻阴影、胶囊按钮',
        'white cards, large rounded corners, delicate shadows, pill buttons',
      ),
      p('light', '弥散的渐变光晕', 'diffuse gradient glow'),
      p('layout', '背景用渐变，内容区干净，层级清晰', 'gradient hero, clean content area, strong hierarchy'),
      p('avoid', '粗描边、纯黑背景、杂乱纹理', 'thick outlines, pure black backgrounds, messy textures'),
    ],
  },
  {
    slug: 'playful-illustration',
    name: '活力扁平插画',
    summary: '明快的扁平插画、圆润字体和高饱和配色，友好有趣，像 Mailchimp、Notion 的品牌页。',
    en: 'Playful flat illustration web design: bright friendly color palette (sunny yellow, coral, sky blue, grass green) on a soft off-white background, custom flat vector illustrations of characters and objects with simple shapes and no outlines, rounded blob shapes and squiggles as decoration, chunky rounded sans-serif headings, pill buttons, generous spacing, warm cheerful approachable mood.',
    prompts: [
      p('style', '活力扁平插画网页', 'playful flat illustration web design'),
      p(
        'color',
        '明快的黄、珊瑚、天蓝、草绿，柔和米白底',
        'sunny yellow, coral, sky blue, grass green on soft off-white',
      ),
      p(
        'material',
        '无描边的扁平矢量插画，圆润的色块和波浪线装饰',
        'outline-free flat vector illustrations, rounded blobs and squiggles',
      ),
      p('layout', '圆润的粗体标题，胶囊按钮，留白充足', 'chunky rounded headings, pill buttons, generous spacing'),
      p('avoid', '写实照片、暗色、细线条', 'photorealism, dark mode, thin lines'),
    ],
  },
  {
    slug: 'corporate-trust',
    name: '企业稳重·信赖蓝',
    summary: '白底配深蓝和天蓝，规整的卡片和图表，字体清晰，金融、企业服务类产品常用。',
    en: 'Corporate trustworthy web design for finance and enterprise: clean white background, deep navy and confident blue as primary colors with a light sky-blue tint for sections and a small green accent for success states, orderly card grid with thin light-grey borders, clear data tables and charts, professional sans-serif typography, restrained 6px corners, subtle shadows, stable reliable professional mood.',
    prompts: [
      p('style', '企业稳重风网页', 'trustworthy corporate web design'),
      p(
        'color',
        '白底、深海军蓝和蓝色为主、浅天蓝区块、少量绿色表示成功',
        'white background, deep navy and blue, light sky-blue sections, small green for success',
      ),
      p('material', '浅灰细边框卡片，小圆角，很淡的阴影', 'light grey bordered cards, small corners, subtle shadows'),
      p('layout', '规整的卡片网格，清晰的数据表和图表', 'orderly card grid, clear data tables and charts'),
      p('avoid', '花哨的渐变、卡通插画、过于鲜艳的颜色', 'flashy gradients, cartoon illustration, overly vivid colors'),
    ],
  },
  {
    slug: 'retro-y2k',
    name: '复古未来·Y2K',
    summary: '银色金属、泡泡质感、荧光渐变和星形装饰，千禧年网络审美，酷而有趣。',
    en: 'Y2K retro-futurist web design: glossy chrome and silver metallic gradients, translucent jelly and bubble buttons with strong highlights, holographic iridescent gradients (lilac, baby blue, lime, hot pink), star and sparkle shapes, pixel and globe motifs, bold rounded techno fonts, early-2000s internet optimism, playful cool nostalgic mood.',
    prompts: [
      p('style', 'Y2K 复古未来网页', 'Y2K retro-futurist web design'),
      p(
        'color',
        '银色、淡紫、婴儿蓝、荧光绿、亮粉的炫彩渐变',
        'silver, lilac, baby blue, lime, hot pink holographic gradients',
      ),
      p(
        'material',
        '镀铬金属、半透明果冻泡泡按钮，强高光',
        'chrome metal, translucent jelly bubble buttons, strong highlights',
      ),
      p('layout', '星形和闪光装饰，圆润的科技感字体', 'star and sparkle shapes, bold rounded techno fonts'),
      p('avoid', '极简留白、哑光、低饱和', 'minimal whitespace, matte finish, low saturation'),
    ],
  },
])

/** 内置风格（游戏在前、网页在后）；id 都以 builtin- 开头 */
export const BUILTIN_STYLES: SavedStyle[] = [...GAME, ...WEB]

export const isBuiltinStyle = (id: string) => id.startsWith('builtin-')
