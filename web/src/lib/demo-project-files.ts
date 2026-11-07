/**
 * 演示项目（示例商店）里的文件清单和 README。从 demo-backend.ts 拆出来，那边只管接口
 */

/** 演示项目里的文件，输入 @ 时从这里找 */
export const DEMO_FILES = [
  'package.json',
  'README.md',
  'vite.config.ts',
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
