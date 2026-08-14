# 手机端 App 与 PWA 方案

## 结论

当前阶段采用“联网型可安装 PWA”，不单独开发原生 Android/iOS App。

该路线保留现有响应式网页和同一套 API，用户可从浏览器添加到主屏幕，以独立窗口打开；发布新版本仍只需要更新服务器。对 60-100 人的实验室内部系统，这比维护两个应用商店包、原生登录状态和多套发布流程更简单。

只有出现以下明确需求时，再评估原生壳或原生 App：

- 必须长期使用系统级推送，并需要精细控制通知权限与到达率。
- 需要高频扫码、NFC、蓝牙或其他浏览器能力不足的硬件集成。
- 需要单位 MDM 分发、设备合规或强制版本策略。
- 有经过设计的离线盘点流程，并能处理多设备冲突，而不是简单缓存写请求。

## 当前实现

- `public/manifest.webmanifest`：提供中性的应用名称、主题色、启动范围和安装图标；不声明固定或任意屏幕方向，由操作系统旋转锁和浏览器决定方向。
- `public/icons/`：提供 180、192、512 px 图标及 Android maskable 图标；图标不包含具体实验室名称，方便复用部署。
- `public/sw.js`：只预缓存带版本文件名的 PNG 安装图标。
- `src/scripts/app.ts`：只在 HTTPS 或 localhost 等安全上下文注册 Service Worker，并设置 `updateViaCache: none`。
- `scripts/generate-pwa-icons.py`：可重复生成同一套 PNG 图标。

管理员上传的品牌图标和实验室名称仍会在登录页及工作台实时显示。主屏幕安装图标保持通用库存标识，避免不规则上传图片造成 Android maskable 裁切问题。

## 数据一致性边界

| 资源 | 策略 | 原因 |
| --- | --- | --- |
| 版本化 PWA PNG 图标 | Cache Storage + HTTP 长缓存 | 内容随文件名版本变化，不会污染业务数据 |
| Manifest | `no-cache + ETag` | 浏览器每次可重新验证安装元数据 |
| `sw.js` | `no-cache + ETag` | 浏览器能及时发现新的 Service Worker |
| 哈希 CSS/JS | HTTP 一年 `immutable` | 文件名包含内容指纹 |
| HTML 导航 | 只走网络，不由 Service Worker 接管 | 避免安装后长期停留在旧页面 |
| `/api/`、数据库下载、账号和库存数据 | `no-store`，Service Worker 不拦截 | 保持实时并避免敏感数据持久缓存 |
| POST/PATCH/DELETE | 只走网络，不进入后台队列 | 防止恢复网络后重复入库、出库或覆盖资料 |

系统离线时应明确失败，由用户恢复网络后重新提交。不能使用 Background Sync 自动重放库存写操作。

## 安装条件

- 正式环境必须使用 HTTPS。`http://服务器IP:4388` 仍可作为受控网络内的临时访问方式，但不是安全上下文，不能依赖 PWA 安装或 Service Worker。
- Android 优先使用 Chrome/Edge 的“安装应用”或“添加到主屏幕”。
- iPhone/iPad 使用 Safari 分享菜单中的“添加到主屏幕”。
- 浏览器是否主动显示安装提示由平台决定，网页内不放置无响应或强制弹出的安装按钮。

## 发布与验收

每次修改 manifest、Service Worker 或安装图标时：

1. 递增应用版本，同时更新 `public/sw.js` 的缓存版本。
2. 图标内容变化时修改文件名版本，例如从 `v1` 改为 `v2`；旧文件可在后续版本清理。
3. 运行 `pnpm run build`、`pnpm test` 和生产依赖审计。
4. 验证 manifest 与 `sw.js` 返回 `no-cache`，版本化图标返回 `immutable`。
5. 在 Android Chrome 与 iOS Safari 各执行一次安装、登录、刷新和版本更新。
6. 断网后确认入库、出库和资料修改不会被后台排队；恢复网络后也不会自动产生流水。
7. 卸载测试 PWA 或清除站点数据后，重新安装确认图标和名称正确。

当前自动化测试已验证 manifest 字段、PNG 尺寸、HTTP 缓存头，以及 Service Worker 不拦截导航、manifest、`/api/` 和 POST 请求。真实 Android/iOS 安装与升级仍是发布门禁。

## 参考规范

- MDN, Making PWAs installable: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
- MDN, ServiceWorkerContainer.register: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register
- web.dev, Web app manifest: https://web.dev/learn/pwa/web-app-manifest/
- web.dev, Service workers: https://web.dev/learn/pwa/service-workers/
