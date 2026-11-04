# Command Code 在面板里登录报 Ink 的 raw mode 不支持，浏览器不打开

- 状态：已修复（`server/exec/fake-tty.test.ts` 通过；用 command-code 1.88.2 实测：管道 stdin 下改前报错，改后起本机回调、给出完整的登录链接）
- 症状：设置里点 Command Code 的「登录其他账号」，不跳转网页，报「登录没有完成：没有找到登录凭据」，输出里是 Ink 的报错和 https://github.com/vadimdemedes/ink/#israwmodesupported
- 入口：`server/accounts.ts` 的 `startLogin`；`shared/clis/commandcode.json` 的 `auth.loginTty`
- 根因类型：CLI 的交互界面要终端，面板用管道跑
- 模块：`server`（`server/accounts.ts`、`server/exec/process.ts` 的 `withFakeTty`）、`shared`（`shared/accounts.ts`、`shared/clis/commandcode.json`）
- 关键词：Command Code、登录、cmd login、Ink、raw mode、isRawModeSupported、浏览器不打开、没有找到登录凭据、NODE_OPTIONS

## 现象

用户 2026-11-04 报：Command Code 登录账号不会跳转到对应网页，输出里只有一个 ink 的 GitHub 网址。

## 根因

`cmd login` 用 Ink 画登录界面（`LoginWithApiKey` 组件），组件里用 `useInput` 监听 Ctrl+C，Ink 要把 stdin 切到 raw mode。面板跑登录命令时 stdin 是管道，Ink 抛「Raw mode is not supported on the current process.stdin」，界面卸载，浏览器登录流程（本机回调服务、打开浏览器）也就没起来。那个 GitHub 网址是 Ink 报错里附带的文档链接，不是登录页。

## 修复

- CLI 定义加 `auth.loginTty`：登录命令要终端的 CLI 写 `true`（Command Code）。
- `server/exec/process.ts` 的 `withFakeTty`：跑登录命令时在 `NODE_OPTIONS` 里加一段 `--import=data:…` 预加载，把 stdin 标成终端、`setRawMode` 改成空操作，输出宽度设成 1000 列（Ink 默认按 80 列折行，备用登录链接会被折成两行，面板只截到半截）。登录流程照常自动打开浏览器，凭据写好后面板按原来的轮询认出登录成功。
