# 仓库与文档治理

状态：已采用。最后更新：2026-09-02。

## 1. 决策摘要

采用两个仓库，但只维护一份通用应用源码：

| 仓库 | 可见性 | 主要职责 | 是否拥有应用源码 |
| --- | --- | --- | --- |
| GitHub `okoklabs/openlabstock` | Public | 可构建的 OpenLabStock 应用、公共文档、Issue、Release 和贡献治理 | 是，公开预览与稳定版均以此为唯一主仓 |
| 受控的私有运营仓库或系统 | Private | OpenLabStock 生产运维、客户实例、商业材料、私密安全事件和内部 AI 上下文 | 否，只引用发布版本或镜像 |

`okoklabs/openlabstock` 是通用应用源码的唯一来源。通用应用改动必须在本仓库完成；私有运营仓库不得复制一套可独立演化的应用代码。

这不是“AI 版应用 + 开源版应用”两个产品。AI 可以参与两个仓库，但各自读取不同的 `AGENTS.md`，并遵守信息可见性边界。

## 2. 为什么不维护两份应用

长期维护私有版和公开版两棵源码会造成修复遗漏、迁移分叉、测试翻倍和许可证边界模糊。成熟做法是让可复用产品代码拥有一个主仓，私有能力通过以下稳定边界连接：

- 运行时配置和品牌设置；
- 独立部署编排与基础设施代码；
- 使用公开 API 的控制面、计费、客户门户或支持工具；
- 边界清楚的独立服务或扩展包。

公共应用必须能够独立构建、测试和部署。不能依赖私有仓库中的隐藏源码才能完成基本库存功能。

采用 AGPL 后，不能把同一应用的通用功能仅用“私有构建开关”隐藏起来并假定其天然不受许可证义务影响。需要闭源的商业控制面或集成应保持独立作品和清晰接口；具体衍生作品、网络使用和分发边界应由熟悉开源许可的律师审核。

## 3. 公共应用仓库

建议结构（GitHub 公共仓库）：

```text
openlabstock/
├─ .github/                 # CI、Issue/PR 模板、依赖与安全配置
├─ deploy/                  # 可复用部署示例，不含真实环境值
├─ docs/                    # 用户、管理员、架构和开发文档
├─ src/ scripts/ tests/     # 应用、工具和测试
├─ AGENTS.md                # 公共代码与设计约束
├─ README.md
├─ CHANGELOG.md
├─ ROADMAP.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ CODE_OF_CONDUCT.md
├─ GOVERNANCE.md
├─ SUPPORT.md
├─ TRADEMARKS.md
├─ THIRD_PARTY_NOTICES.md
├─ LICENSE                  # 目标：AGPL-3.0-only
└─ NOTICE                   # 品牌、版权和第三方声明
```

公共仓库包含：

- 对应发布物的完整可构建源码；
- 数据模型、迁移、权限和 API 测试；
- 通用 systemd/Docker/反向代理示例；
- 用户、管理员、开发者、贡献者和公共 AI 文档；
- 公共 Roadmap、Issues、Discussions、Releases 和安全报告入口；
- 可公开的示例配置与去标识化测试数据。

公共仓库不得包含：

- 真实服务器 IP、SSH 用户、主机名和共用站点拓扑；
- `.env`、密钥、Cookie、数据库、备份、日志或真实成员资料；
- 客户清单、价格、合同、CLA 签署记录和销售计划；
- 未公开漏洞、安全事件、支持会话和内部调查材料；
- 个人聊天历史、模型记忆或与贡献无关的 AI 提示词。

## 4. 私有运营仓库

建议结构（GitHub 私有仓库）：

```text
openlabstock-operations/
├─ AGENTS.md                # 私有环境、发布和保密约束
├─ README.md                # 入口、联系人和权限边界
├─ docs/
│  ├─ runbooks/             # 部署、备份、恢复和故障手册
│  ├─ decisions/            # 内部 ADR 与商业决策
│  └─ incidents/            # 私密事件记录
├─ infrastructure/          # 无密钥的声明式配置或自动化
├─ customers/               # 受限客户实例元数据
├─ commercial/              # 合同、报价和双授权资料
└─ compliance/              # CLA、版权链和发布证据
```

私有仓库保存环境专属和商业敏感材料，但“Private”不等于可以提交密码。凭据仍应存入密码管理器、云密钥服务或 GitHub Environments，仓库只记录变量名、负责人和轮换流程。

私有 `AGENTS.md` 可以说明真实部署拓扑、审批与回滚规则；它引用公共应用的架构和版本，不复制公共 `AGENTS.md` 的全部业务约束。AI 不得把私有内容概括后写回公共仓库，除非维护者明确批准且内容已经去标识化。

## 5. 开源与商业代码边界

当前建议边界如下：

| 公共 AGPL 应用 | 可保持私有的独立能力 |
| --- | --- |
| 单实验室库存、成员、权限、流水、导入导出 | 多客户控制面与实例编排 |
| SQLite 数据层、迁移、备份恢复 | 计费、订阅、合同和客户门户 |
| 状态化库存、二维码、PWA | 客户专属 SSO/系统集成（按独立边界评估） |
| 通用 Docker/systemd 部署 | 托管监控、支持工具和运营告警 |
| 公共 API 和插件接口 | 内部销售、支持和合规工作流 |

品牌和商标与代码许可证分开治理。开源许可证允许依法使用代码，不当然授权第三方冒充官方 OpenLabStock/OKOKLabs 服务。

## 6. TODO、Issue、Project 和 Roadmap

不同工具解决不同时间尺度的问题，不要求每个个人想法都创建公开 Issue。

| 工具 | 用途 | 可见性 | 维护规则 |
| --- | --- | --- | --- |
| `TODO.md` | 当前 5-10 个可执行事项和临时收件箱 | 随所在仓库 | 短、可验收；定期提升或删除 |
| GitHub Issue | 已澄清、需要讨论或跨提交跟踪的工作 | 公共或私有 | 一项问题一个 Issue，关闭时写结论 |
| GitHub Project | 跨 Issue 的优先级和阶段看板 | 公共或私有 | 不复制 Issue 正文 |
| Milestone | 一个版本或明确交付窗口 | 通常公共 | 只收有交付目标的 Issue |
| `ROADMAP.md` | Now/Next/Later 方向与触发条件 | 公共路线公开 | 不承诺日期，不代替 Issue |
| `CHANGELOG.md` | 已发布且用户可感知的变化 | 公共 | 不记录待办和完整测试日志 |
| ADR/决策记录 | 重要且难以逆转的技术/产品决策 | 按内容分类 | 写背景、选择、后果和日期 |

任务分类：

```md
- [ ] [LOCAL] 核对 Android 输入法真机表现
- [ ] [PRIVATE operations#42] 演练正式实例恢复
- [ ] [PUBLIC openlabstock#123] 增加盘点任务与差异复核
```

- `[LOCAL]`：维护者当前工作，可暂时没有 Issue；超过一个迭代或需要协作时提升为 Issue。
- `[PRIVATE]`：生产、客户、商业、安全或未公开决策；进入私有运营仓库的 Issue/Project。
- `[PUBLIC]`：公共 Bug、通用需求或可接受外部贡献的工作；进入公共应用仓库 Issue。
- 安全漏洞不进入普通公开 Issue，按 `SECURITY.md` 使用私密漏洞报告。

本仓库根 `TODO.md` 只能保留可公开事项；个人草稿可使用被 Git 忽略的 `TODO.private.md`，需要长期保存或协作的内部事项必须进入受控的私有 Issue 或任务系统。

## 7. AI 文档边界

两个仓库都可以有 `AGENTS.md`，但目的不同：

- 公共 `AGENTS.md`：数据不变量、权限、设计系统、测试门禁和贡献约束；任何外部贡献者都可据此工作。
- 私有 `AGENTS.md`：真实环境、客户/商业保密、发布权限和内部运行手册；只对获准维护者与 AI 开放。

两者都不应保存聊天逐字稿、临时模型思考或凭据。可复用知识应整理成短规则、领域文档、ADR 或测试；过时规则要修订，不能无限追加。

## 8. 来源与发布关系

1. 本仓库以经过许可证、依赖、密钥和信息边界审查的干净初始提交开始，不导入不适合公开的历史。
2. 后续通用应用改动、数据库迁移、测试和公共文档均在本仓库完成并接受 CI 门禁。
3. 部署、镜像和私有运营自动化只引用本仓库的确切 Git tag、Release 或镜像摘要，不复制应用源码继续开发。
4. 每个公开发行物都应能追溯到本仓库提交，并包含对应许可证与第三方通知。
5. 版权来源、历史开发证据、CLA 签署导出和法律意见由私有合规记录保存，不进入本仓库。

本仓库已经包含标准 AGPL 原文、社区治理文件和依赖许可门禁，但这不等于 CLA 已生效或已经取得所有外部贡献的商业再许可权。启用 CLA 和接受外部版权性贡献前仍须完成 `CLA.md` 与 [`CLA Assistant 门禁`](./CLA_ASSISTANT_SETUP.md)中列明的审查和测试。

## 9. 成熟项目对照

2026-09-02 对公开仓库根结构和若干成熟项目进行了轻量核对：

| 项目 | 根目录治理文档 | 对本项目的启示 |
| --- | --- | --- |
| [Snipe-IT](https://github.com/grokability/snipe-it) | README、LICENSE、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT | 公共使用、许可、贡献和安全入口彼此独立 |
| [InvenTree](https://github.com/inventree/InvenTree) | 上述文件以及 AGENTS、CHANGELOG，另有 `docs/` | AI/维护者规则可以公开；版本变化与开发文档各有入口 |
| [eLabFTW](https://github.com/elabftw/elabftw) | README、LICENSE、CONTRIBUTING、SECURITY、CHANGELOG，另有 `documentation/` | 根目录保持项目治理入口，详细说明进入文档目录 |
| [Home Assistant](https://github.com/home-assistant/core)、[Directus](https://github.com/directus/directus)、[Appwrite](https://github.com/appwrite/appwrite) | README、LICENSE、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT，并公开 `AGENTS.md` 或同类 AI 维护规则 | AI 规则可以公开，但应只写可复用的工程约束；真实运维和敏感上下文仍放私有系统 |

这些项目并不要求把生产拓扑、客户或商业材料放进公共应用仓库。OpenLabStock 应采用相同的职责分离，同时保留符合自身 SQLite、实验室权限和部署方式的文档内容。

## 10. 参考规范

- [GitHub Docs: About Issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues)
- [GitHub Docs: About Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
- [GitHub Docs: Configuring private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)
- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
- [GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html)

这些资料支持任务、版本和安全报告的工程组织方式；许可证、CLA、商标和商业双授权的最终文本仍需专业法律意见。
