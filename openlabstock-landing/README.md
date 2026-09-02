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

调研日期：2026-09-02。

- [Linear](https://linear.app/)：参考“真实产品界面就是首要视觉”的表达、克制导航和分章节编号。
- [Supabase](https://supabase.com/)：参考把开源身份放在主叙事中，而非只做页脚标签；产品截图承担能力说明。
- [PostHog](https://posthog.com/)：参考高信息密度与鲜明但不浮夸的品牌语气。
- [Cal.com](https://cal.com/)：参考浅色基底、清楚的大标题和产品展示节奏。
- [Quartzy](https://www.quartzy.com/)：用于了解实验室软件常见的库存、采购和移动端痛点表达；本站文案进一步聚焦 OpenLabStock 已真实交付的能力。
- [GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)：参考“源码仓库用于协作、Release 用于固定版本、变更摘要和可验证资产”的入口分工。
- [Home Assistant 安装文档](https://www.home-assistant.io/installation/)：参考按用户目标提供多条安装路径，而不是把 Docker、系统安装和试用步骤混在一个长命令块里。
- [Snipe-IT 文档](https://snipe-it.readme.io/docs)：参考把首次部署、升级、备份和故障恢复拆成独立任务，降低第一次安装时的认知负担。

最终没有照搬任何页面。视觉以现有 OpenLabStock 的绿色、Material 3 工作台和真实截图为基础，增加琥珀预警色与浅蓝收束区，避免整页只剩一种绿色。

## 文案边界

- “微信扫一扫”表述为扫码直达确认表单，不声称扫码即改变库存。
- 没有使用未经验证的客户数量、节省时间比例、客户评价或商业托管承诺。
- 开源许可写明为当前真实的 `AGPL-3.0-only`。
- 页面直接链接公开源码仓库、发布页、快速启动、部署和贡献文档；当前文案明确这是公开预览，不把未完成的托管服务写成现成产品。

## 公开入口与安装路径

官网的主 CTA 只保留三个可兑现动作：

1. **先看流程**：从产品截图和扫码登记说明理解工作流。
2. **先试用**：进入公开仓库的快速启动，在本机用合成数据体验。
3. **正式部署**：进入部署文档，选择单机 systemd 或 Docker；生产数据和备份始终独立于程序目录。

公开仓库地址：<https://github.com/okoklabs/openlabstock>。

GitHub Release 不是安装的硬性前提，但建议在一次全新 Linux 安装、升级、备份、恢复和回滚演练通过后，再以版本标签和 Release 附上生产包、清单、SHA-256 与变更摘要。这样普通用户可以从仓库试用，运维人员可以从 Release 取得经过验证的发布包，二者都不需要从临时分支猜版本。
