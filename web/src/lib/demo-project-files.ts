/**
 * 演示项目（示例商店）里的文件清单和 README。从 demo-backend.ts 拆出来，那边只管接口
 */
import type { SheetData } from '@shared/files'

/** 演示项目里的文件，输入 @ 时从这里找 */
export const DEMO_FILES = [
  'package.json',
  'README.md',
  'vite.config.ts',
  'data/products.csv',
  'data/stock.xlsx',
  'data/C_HomeDecorationConfig.xlsx',
  'src/main.tsx',
  'src/App.tsx',
  'src/api/cart.ts',
  'src/api/orders.ts',
  'src/api/products.ts',
  'src/components/CartBadge.tsx',
  'src/components/ProductCard.tsx',
  'src/components/RestockButton.tsx',
  'src/pages/Login.tsx',
  'src/pages/OrderList.tsx',
  'src/pages/ProductDetail.tsx',
  'src/store/cart.ts',
  'src/utils/date.ts',
  'src/utils/format.ts',
  'tests/cart.test.ts',
]

/** 演示项目的 README.md：分了几节，文件窗口里能看到右边的标题目录（DocOutline） */
export const DEMO_README =
  '# 示例商店\n\n演示用的前端项目，故意留了几处没改完的地方。\n\n## 快速开始\n\n安装依赖后运行开发服务器：\n\n```bash\nnpm install\nnpm run dev\n```\n\n## 目录结构\n\n- `src/api`：和后端打交道的请求\n- `src/components`：页面里复用的部件\n- `src/pages`：各个页面\n- `src/store`：购物车状态\n\n### 页面\n\n登录、商品详情、订单列表三个页面，路由写在 `src/App.tsx`。\n\n### 状态\n\n购物车放在 `src/store/cart.ts`，角标 `CartBadge` 读它显示数量。\n\n## 已知问题\n\n- 订单列表的日期按 UTC 显示，跨天时会差一天\n- 补货按钮连点会发两次请求\n- 购物车删除后角标不刷新\n\n## 测试\n\n```bash\nnpm test\n```\n\n单测在 `tests/` 下，目前只覆盖了购物车。\n\n## 发布\n\n合到 main 后自动构建并部署到预发环境，确认没问题再手动发布到线上。\n'

/** 演示项目里的 CSV：文件窗口阅读时按表格显示（有带逗号、带引号的格子） */
export const DEMO_CSV =
  'id,name,price,stock,note\n' +
  'p-1001,机械键盘,399,128,"青轴, 87 键"\n' +
  'p-1002,无线鼠标,129,340,\n' +
  'p-1003,显示器支架,219,56,"承重 9kg，带 ""快拆"" 底座"\n' +
  'p-1004,USB-C 扩展坞,289,0,缺货，等补货\n' +
  'p-1005,降噪耳机,899,73,\n'

/** 演示项目里的 xlsx：正式版由服务端解析成各张表，演示里直接给解析后的样子 */
export const DEMO_SHEETS: Record<string, SheetData[]> = {
  'data/stock.xlsx': [
    {
      name: '库存',
      rows: [
        ['商品', '仓库', '数量', '更新时间'],
        ...Array.from({ length: 240 }, (_, i) => [
          `p-${1001 + (i % 5)}`,
          ['上海', '成都', '广州'][i % 3],
          String((i * 37) % 400),
          `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        ]),
      ],
    },
    {
      name: '补货记录',
      rows: [
        ['日期', '商品', '补了多少', '经办人'],
        ['2026-01-12', 'p-1004', '200', '小林'],
        ['2026-01-20', 'p-1003', '80', '小周'],
      ],
    },
  ],
  // 游戏配置表：前 5 行是表头（修饰 / 导出端 / 类型 / 字段名 / 注释），文件窗口自动识别、分色、钉在顶上
  'data/C_HomeDecorationConfig.xlsx': [
    {
      name: 'C_HomeDecorationConfig',
      rows: [
        ['optional', 'optional', 'optional', 'optional', 'optional', 'repeated', 'optional'],
        ['Client', 'Client', 'Client', 'Client', 'Editor', 'Client', 'Client'],
        ['uint32', 'uint32', 'HomeDecorationSizeType', 'HomeDecorationMountType', 'bytes', 'uint32', 'int32'],
        [
          'ID',
          'EntryID',
          'SizeType',
          'MountType',
          'DisplayName',
          'InteractionAllowCharacterIDs',
          'InteractionTriggerState',
        ],
        [
          '全局唯一软装配置ID',
          '交互物Entry ID',
          '家具尺寸',
          '家装挂载类型',
          '软装显示名',
          '交互白名单角色基础ID列表，为空表示不限制',
          '触发交互状态，默认-1表示未配置',
        ],
        ...Array.from({ length: 120 }, (_, i) => [
          String(i + 1),
          String(781713001 + i),
          ['S', 'XS', 'M', 'L'][i % 4],
          ['FloorMirror', 'WallMirror', 'TabletopDecor'][i % 3],
          ['曲线穿衣镜', '镀金画框挂镜', '桌上圆镜', '落地拱形镜', '藤编圆挂镜'][i % 5] +
            (i >= 5 ? ` ${Math.floor(i / 5) + 1}` : ''),
          i % 7 === 3 ? '1001;1003' : '',
          i % 11 === 4 ? '2' : '-1',
        ]),
      ],
    },
  ],
}
