# OpenLabStock 实验室耗材管理

OpenLabStock 是面向实验室与科研团队的自托管耗材管理系统，覆盖日常领用、库存盘点、可追溯流水和管理审计。它既支持按数量管理的普通耗材，也支持探针等按盒、位置、状态和使用范围管理的可复用物品。

> **发布状态：公开前审查中。** 当前代码可用于评估和内部测试，但第一个公共 Release、CLA 签署和外部版权性贡献入口尚未启用。请勿把生产数据库、账号或服务器信息提交到仓库。

## 核心能力

- 以不可变流水记录入库、领用、Excel 差额调整和纠错事件。
- 支持系统所有者、系统管理员、库存管理员和普通成员的后端权限校验。
- 支持普通数量、状态化库存、盒/批次/序列和唯一位置编号。
- 支持开放使用与成员自用，并把可复用物品的当前状态与每次使用分开记录。
- 支持耗材与库存单元二维码；扫码只定位并打开确认表单，不直接改变库存。
- 支持库存预警、服务器分页记录、Excel/CSV 导入导出和组织消耗统计。
- 支持系统审计、盘点批次、差异复核、SQLite 一致性备份与受控恢复。
- 提供桌面、平板和手机端 Material 3 工作界面，并支持受限联网型 PWA。

完整业务边界见[系统架构](./docs/BUILD_ARCHITECTURE.md)和[状态化库存规则](./docs/INVENTORY_TRACKING.md)。

## 本地启动

要求 Node.js `>=22.12.0` 和仓库声明的 pnpm 版本。

```powershell
pnpm install --frozen-lockfile
pnpm run verify:quick
pnpm run build
pnpm run start
```

打开 <http://127.0.0.1:4388/>。仅在本地非生产模式会创建演示账号：

- 系统所有者：`admin` / `admin123`
- 普通成员：`student` / `demo123`

生产模式不会创建演示数据，首次启动必须通过环境变量设置独立所有者密码。运行数据默认位于被 Git 忽略的 `data/`。

## 验证

```powershell
pnpm run verify:quick   # 日常代码改动
pnpm run verify         # 高风险改动、合并和正式发布
pnpm run check:docs     # 纯文档改动
pnpm run check:licenses # 项目和生产依赖许可策略
```

风险分级、浏览器检查、发布和回滚门禁以[工程工作流](./docs/ENGINEERING_WORKFLOW.md)为准。测试使用临时端口、临时数据库和合成数据，不得连接生产环境。

## 部署

- [部署概览](./DEPLOYMENT.md)：Node/systemd、HTTPS、数据目录和安全边界。
- [Docker 部署](./deploy/docker/README.md)：初始化、备份、更新、回滚和隔离烟测。
- [生产包约定](./deploy/PRODUCTION.md)：发布包内容、版本和健康检查。

生产数据库、备份、`.env`、密钥和服务器清单绝不能进入源码、发布包或 Issue。默认部署只监听 `127.0.0.1:4388`，公网访问应由受控的 HTTPS 反向代理提供。

## 文档

- 使用者与部署者从本页和[部署概览](./DEPLOYMENT.md)开始。
- 开发者先读[文档指南](./docs/DOCUMENTATION.md)、[`AGENTS.md`](./AGENTS.md)和[工程工作流](./docs/ENGINEERING_WORKFLOW.md)。
- 产品取舍与成熟方案参考见 [`PRODUCT_REVIEW.md`](./PRODUCT_REVIEW.md)。
- 长期方向、近期工作和已发布变化分别见 [`ROADMAP.md`](./ROADMAP.md)、[`TODO.md`](./TODO.md)和 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可与贡献

OpenLabStock 原始源码采用 [GNU Affero General Public License v3.0 only](./LICENSE)，SPDX 标识为 `AGPL-3.0-only`。第三方组件继续适用各自许可，见 [`NOTICE`](./NOTICE) 与 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。AGPL 允许商业使用，但网络部署、修改和再分发必须遵守其源码可得性等义务。

项目计划提供替代商业许可，但当前尚未开放签约；[`COMMERCIAL.md`](./COMMERCIAL.md)不是商业授权。为保留双授权能力，外部版权性贡献必须在个人 CLA 完成专业复核并通过可审计签署流程后才能合并。当前 [`CLA.md`](./CLA.md)仍为 `NOT ACTIVE`，不接受签署。

项目与 CLA 联系邮箱：`contact@okoklabs.com`。安全漏洞必须通过 [`SECURITY.md`](./SECURITY.md) 规定的私密渠道报告，不要发送到普通联系邮箱。

## 社区与治理

- 贡献流程：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全漏洞：[`SECURITY.md`](./SECURITY.md)
- 行为准则：[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- 项目治理：[`GOVERNANCE.md`](./GOVERNANCE.md)
- 支持边界：[`SUPPORT.md`](./SUPPORT.md)
- 名称与标识：[`TRADEMARKS.md`](./TRADEMARKS.md)
