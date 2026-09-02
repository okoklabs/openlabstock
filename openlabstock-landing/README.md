# OpenLabStock Landing Page

这是为 `openlabstock.com` 准备的独立静态宣传页。所有新增文件、演示数据与测试产物都限制在 `openlabstock-landing/` 内，没有修改现有 OpenLabStock 应用、构建配置、TODO 或其他项目文件。

## 文件

- `index.html`：宣传页结构与中文产品文案。
- `flyer-a4.html`：A4 竖版单页宣传页，可直接在浏览器中预览并按 100% 比例彩色打印。
- `styles.css`：完整桌面、平板与手机响应式视觉。
- `script.js`：移动导航、渐入动效与产品大图预览。
- `DEPLOYMENT.md`：`openlabstock.com` 的 Caddy 部署、更新、验证与回滚笔记。
- `assets/product-dashboard-2x.png`：使用隔离演示数据库按 2 倍像素重新渲染的真实桌面端产品截图。
- `assets/product-mobile.png`：用于 A4 宣传页首张产品图的真实手机端库存单元与登记界面。
- `assets/product-inventory-2x.png`：使用隔离演示数据库按 2 倍像素重新渲染的真实库存管理截图，用于产品能力区，避免重复首屏素材。
- 扫码登记区的手机界面由 HTML/CSS 直接渲染，保持真实手机比例，放大与全屏演示时文字仍然清晰。
- `assets/scan-demo-qr.png`：网站长页扫码登记章节使用的页面演示二维码，不是耗材业务二维码。
- `assets/openlabstock-site-qr.png`：A4 宣传页使用的产品主页二维码，指向 `https://openlabstock.com/`，进入后可查看扫码登记流程。
- `assets/openlabstock-icon.png`：从现有项目品牌图标复制的站点图标。
- `assets/landing-desktop-preview.png` 与 `assets/landing-mobile-preview.png`：最终桌面、手机首屏验收预览；桌面图同时作为社交分享图。

直接双击 `index.html` 即可预览，不需要安装依赖或启动服务。

打印宣传页时直接打开 `flyer-a4.html`，选择 A4、实际大小（100%），并关闭浏览器页眉页脚。纸面以白色和浅色分区为主，只在标题、流程线和页脚使用高浓度品牌色，以兼顾彩色辨识度与常见喷墨、激光打印机的耗墨量。

电脑端右上角提供“全屏演示”。进入后每个章节使用独立的 16:9 舞台，滚轮、空格、方向键和 PageUp / PageDown 均按整页切换；右下角可查看页码、前后翻页或退出。手机端继续使用自然长页，不启用演示布局。

## 设计调研

设计调研日期：2026-08-14；公开仓库与发布状态复核：2026-09-02。

- [Linear](https://linear.app/)：参考“真实产品界面就是首要视觉”的表达、克制导航和分章节编号。
- [Supabase](https://supabase.com/)：参考把开源身份放在主叙事中，而非只做页脚标签；产品截图承担能力说明。
- [PostHog](https://posthog.com/)：参考高信息密度与鲜明但不浮夸的品牌语气。
- [Cal.com](https://cal.com/)：参考浅色基底、清楚的大标题和产品展示节奏。
- [Quartzy](https://www.quartzy.com/)：用于了解实验室软件常见的库存、采购和移动端痛点表达；本站文案进一步聚焦 OpenLabStock 已真实交付的能力。

最终没有照搬任何页面。视觉以现有 OpenLabStock 的绿色、Material 3 工作台和真实截图为基础，增加琥珀预警色与浅蓝收束区，避免整页只剩一种绿色。

## 文案边界

- “微信扫一扫”表述为扫码直达确认表单，不声称扫码即改变库存。
- 没有使用未经验证的客户数量、节省时间比例、客户评价或商业托管承诺。
- 开源许可写明为当前真实的 `AGPL-3.0-only`。
- 公共仓已以公开预览形式提供；页面仍没有放置未经维护承诺的在线演示 CTA，源码入口以根目录 README 和公开仓库链接为准。
