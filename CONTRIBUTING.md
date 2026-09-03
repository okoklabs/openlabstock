# Contributing to OpenLabStock

感谢你参与 OpenLabStock。库存、权限和审计代码会直接影响实验室真实记录，因此贡献流程强调可复现、可审查和数据安全。

## 开始之前

1. 阅读 [`README.md`](./README.md)、[`AGENTS.md`](./AGENTS.md)和[工程工作流](./docs/ENGINEERING_WORKFLOW.md)。
2. Bug、安全问题和功能讨论使用不同入口；安全漏洞必须按 [`SECURITY.md`](./SECURITY.md)私下报告。
3. 较大的功能、数据模型变化或界面重构先创建 Issue，确认问题和验收口径后再实现。
4. 不得提交真实数据库、备份、账号、日志、服务器信息、客户资料、凭据或从生产环境截取的个人数据。

## 本地开发

要求 Node.js `>=22.12.0` 和仓库声明的 pnpm 版本：

```bash
pnpm install --frozen-lockfile
pnpm run verify:quick
pnpm run build
pnpm run start
```

本地地址为 <http://127.0.0.1:4388/>。测试必须使用临时数据库和合成数据。

## 修改要求

- 保持提交聚焦，不夹带无关重构或生成文件。
- 后端权限校验是最终边界，不能只隐藏前端按钮。
- 所有库存写入必须保持事务、流水和审计不变量。
- 数据库结构变化必须包含事务迁移、旧库升级测试和失败路径。
- 用户可感知变化更新 `CHANGELOG.md`；长期方向、短期任务和历史变化不得混写。
- 界面修改遵守 Material 3、键盘可访问性以及桌面与 `390 x 844` 手机验收要求。

日常改动运行：

```bash
pnpm run verify:quick
```

数据库、认证、权限、备份恢复、二维码、Docker、共享库存写入或正式发布相关改动运行：

```bash
pnpm run verify
```

## Pull Request

PR 应说明：

- 要解决的问题和选择该方案的原因；
- 用户可见行为、数据结构或权限是否变化；
- 已运行的自动化和人工验证；
- 数据迁移、回滚、安全和隐私影响；
- 关联 Issue。

维护者可以要求拆分过大的 PR。合并需要 CI 通过、评审意见处理完毕，并满足相应贡献许可要求。

## 贡献许可

项目采用 `AGPL-3.0-only + 替代商业许可`。为保留双授权能力，外部代码、文档、设计和翻译贡献在合并前必须通过已启用并经验证的 CLA 流程。

当前 [`CLA.md`](./CLA.md) 是自 2026-09-03 起生效的个人 CLA v1.0，被授权方为 **郝春霖 (Hao Chunlin)**。贡献者必须通过 CLA Assistant 展示的正式协议完成签署，仓库以 `license/cla` 状态作为合并依据。仅在 PR 文本中勾选一句话、评论或发送邮件，不能替代有效且可追踪的签署记录。

需要提交由公司、学校或其他组织所有的材料时，应先联系项目；个人 CLA 不当然覆盖组织权利，当前尚未开放 Entity CLA。协议的中文解释见[个人 CLA 中文说明](./docs/legal/CLA_GUIDE.zh-CN.md)，签署数据范围和境外处理说明见[CLA 隐私说明](./docs/legal/CLA_PRIVACY_NOTICE.md)。

提交 Issue、复现信息和不构成版权性作品的简短建议不要求签署 CLA。

## 社区行为

所有参与者均须遵守 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)。一般使用问题见 [`SUPPORT.md`](./SUPPORT.md)。
