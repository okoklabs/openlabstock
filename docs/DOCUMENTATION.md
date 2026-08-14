# OpenLabStock 文档指南

本文是文档治理入口：按受众说明从哪里开始、每类事实由哪份文档负责，以及哪些内容不能进入公共仓库。

## 按受众阅读

### 使用者

1. [`README.md`](../README.md)：产品能力和本地启动。
2. [`DEPLOYMENT.md`](../DEPLOYMENT.md)：本机、局域网和 HTTPS 部署概览。
3. [`INVENTORY_TRACKING.md`](./INVENTORY_TRACKING.md)：状态、盒、位置、自用与使用登记口径。

### 部署与运维人员

1. [`deploy/docker/README.md`](../deploy/docker/README.md)：可复用 Docker 部署流程。
2. [`deploy/PRODUCTION.md`](../deploy/PRODUCTION.md)：发布包运行约定。
3. [`QR_CODE_WORKFLOW.md`](./QR_CODE_WORKFLOW.md) 与 [`PWA_MOBILE_APP.md`](./PWA_MOBILE_APP.md)：专项部署条件和验收。

### 开发者与 AI

1. [`AGENTS.md`](../AGENTS.md)：数据、权限、界面和发布硬约束。
2. [`BUILD_ARCHITECTURE.md`](./BUILD_ARCHITECTURE.md)：当前技术架构和数据模型。
3. [`ENGINEERING_WORKFLOW.md`](./ENGINEERING_WORKFLOW.md)：开发、验证、发布和回滚的唯一流程。
4. [`TODO.md`](../TODO.md)：当前短期收件箱；不是全部需求数据库。
5. [`ROADMAP.md`](../ROADMAP.md)：阶段方向和触发条件；不是交付承诺。
6. [`PRODUCT_REVIEW.md`](../PRODUCT_REVIEW.md)：成熟产品先例与业务取舍。

### 项目治理者

1. [`REPOSITORY_GOVERNANCE.md`](./REPOSITORY_GOVERNANCE.md)：公共应用仓库、私有运营仓库、任务系统和信息边界。
2. [`GOVERNANCE.md`](../GOVERNANCE.md)、[`CONTRIBUTING.md`](../CONTRIBUTING.md)与 [`SECURITY.md`](../SECURITY.md)：公共治理、贡献和漏洞报告入口。
3. [`CHANGELOG.md`](../CHANGELOG.md)：用户可感知的已发布变化。
4. [`CLA.md`](../CLA.md)、[`legal/CLA_GUIDE.zh-CN.md`](./legal/CLA_GUIDE.zh-CN.md)与 [`CLA_ASSISTANT_SETUP.md`](./CLA_ASSISTANT_SETUP.md)：个人贡献授权候选文本、中文解释和签署系统启用门禁。

## 单一事实来源

| 主题 | 权威文件 | 不应放入 |
| --- | --- | --- |
| 长期工程硬约束 | `AGENTS.md` | 某次测试日志、聊天记录、商业秘密 |
| 当前短期工作 | `TODO.md` / 对应 Issue | 长期愿望、已完成版本流水账 |
| 产品方向与触发条件 | `ROADMAP.md` | 具体实现步骤、确定发布日期 |
| 用户可感知的发布变化 | `CHANGELOG.md` / GitHub Release | 完整测试输出、服务器操作记录 |
| 架构和数据模型 | `BUILD_ARCHITECTURE.md` | 临时调试过程 |
| 验证和发布门禁 | `ENGINEERING_WORKFLOW.md` | 在其他文档复制另一套命令 |
| 通用部署方式 | `DEPLOYMENT.md`、`deploy/` | 客户、IP、凭据和真实备份 |
| 当前环境运维 | 私有运营仓库 | 公共应用仓库 |
| 开源许可证与第三方通知 | `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` | 商业合同、CLA 签署记录 |
| 社区治理与报告入口 | `GOVERNANCE.md`、`CONTRIBUTING.md`、`SECURITY.md` | 私密事件、举报人身份 |
| 个人贡献授权文本与公开流程 | `CLA.md`、`docs/legal/`、`docs/CLA_ASSISTANT_SETUP.md` | 签署导出、法务意见、身份证明、雇主授权材料 |
| 产品研究依据 | `PRODUCT_REVIEW.md` | 没有来源的阶段性猜想 |

## 文档生命周期

1. 新需求先进入短期 `TODO.md`、公共 Issue 或私有 Issue，不立即扩充 Roadmap。
2. 已确认的长期方向进入 `ROADMAP.md`，同时写明触发条件；具体执行仍由 Issue 跟踪。
3. 业务或架构规则变化时，同一提交更新实现、测试和对应权威文档。
4. 用户可感知的已发布变化进入 `CHANGELOG.md`；构建 SHA-256 进入 Release/包清单，测试细节留在 CI。
5. 已失效的说明直接修订或删除；需要保留决策背景时写带日期的审查或 ADR，不在多份文档保留冲突版本。
6. 新建文档前先确认它拥有新的事实。若只是解释已有内容，应链接权威文件。

## 公开边界

本仓库只保留产品、通用部署、开发、贡献、安全和公共 AI 约束。生产拓扑、真实服务器与账号、客户资料、商业合同、CLA 签署记录、未公开安全事件和内部 AI 上下文必须保存在受控的私有系统中，也不能通过 Issue、测试数据、构建产物或历史提交带入本仓库。

公共应用与私有运营资料的职责以 [`REPOSITORY_GOVERNANCE.md`](./REPOSITORY_GOVERNANCE.md) 为准。发现疑似泄露时停止继续传播，按 [`SECURITY.md`](../SECURITY.md) 私下报告并评估历史清理和凭据轮换。
