# CLA Assistant 启用与验收

本文是 `okoklabs/openlabstock` 使用托管版
[CLA Assistant](https://cla-assistant.io/) 的操作清单。它不替代
[`CLA.md`](../CLA.md) 的法律审查，也不保存任何签署人的个人数据。

## 1. 启用门槛

以下项目必须全部完成：

- [ ] `contact@okoklabs.com` 已转发到可用收件箱；收件已经验证，启用 CLA 前仍需完成
  回复身份、垃圾邮件和账号恢复检查。实际后台收件箱不得写入 Git。
- [ ] `okoklabs/openlabstock` 公共仓库已经从审查后的干净工作树建立。
- [ ] 项目负责人确认公开身份为 `郝春霖 (Hao Chunlin)`，私有合规记录保存必要的
  身份和权利链证据。
- [ ] 熟悉中国大陆适用法律的专业人士复核个人 CLA，包括已补入的准据法和争议
  处理条款，并将候选版本冻结为正式 `1.0`。
- [ ] CLA Assistant 当时的隐私说明、服务状态和数据导出能力已经复核。
- [ ] 组织所有的贡献暂不接受；确有公司贡献需求时另行制定 Entity CLA。

任一项未完成时，`CLA.md` 必须保持 `NOT ACTIVE`，也不得把 CLA 状态检查设成已经
可以接受外部贡献的象征性门禁。

## 2. 准备协议 Gist

1. 从复核后的 `CLA.md` 复制**正式协议正文**到一个 GitHub Gist 文件。不要复制
   候选状态提示、未解决占位符或本页操作说明。
2. 在同一 Gist 增加名为 `metadata` 的文件，内容必须与
   [`.github/cla/metadata.json`](../.github/cla/metadata.json) 的已复核版本一致。
   CLA Assistant 要求文件名是 `metadata`，不是 `metadata.json`。
3. 在私有合规记录中保存 Gist URL、Gist revision SHA、协议版本、协议文件
   SHA-256、metadata SHA-256、复核人和冻结时间。不要把签署人导出表放入公共 Gist
   或公共仓库。
4. Gist 只承载已经冻结的协议。拼写修正也会形成新修订，并可能触发重新签署；先在
   仓库候选文件中评审，再更新 Gist。

CLA Assistant 的自定义字段格式以其官方
[JSON Schema](https://raw.githubusercontent.com/cla-assistant/cla-assistant/main/custom-fields-schema.json)
为准。本项目只要求法定姓名、联系邮箱和三项资格确认，不收集家庭住址、证件号码、
电话或雇主名称。

## 3. 连接仓库

1. 由 `okoklabs` Organization 的受控 Owner 账号登录
   [cla-assistant.io](https://cla-assistant.io/)，授权 CLA Assistant。
2. 只为 `okoklabs/openlabstock` 安装或授权所需仓库权限，不选择所有未来仓库。
3. 在 CLA Assistant 控制台把该仓库连接到冻结后的 Gist，并确认页面展示的是正式
   `1.0` 文本和预期的双语字段。
4. 创建测试 PR，观察 CLA Assistant 实际发布的提交状态名称。当前官方实现使用
   `license/cla`；分支规则必须以仓库实际出现的状态为准，避免手工输入一个从未
   上报的检查名称。
5. 在 GitHub Ruleset 或分支保护中把质量 CI 和 `license/cla` 同时设为合并必需。
   管理员绕过权限只授予紧急维护角色，并要求在私有运营记录中说明原因。

不要安装已经归档的 `contributor-assistant/github-action`，也不要为 CLA 创建使用
`pull_request_target` 和仓库写令牌的自制工作流。托管 CLA Assistant 通过 GitHub
身份和独立签署记录完成核验，公共 CI 不应接触签署人导出数据。

## 4. 激活前测试矩阵

使用非维护者测试账号从 fork 提交不含真实业务数据的小型 PR：

| 场景 | 预期结果 |
| --- | --- |
| 未签署 | CLA 评论出现；`license/cla` 为 pending/failure；分支规则阻止合并 |
| 完成签署 | 显示正式协议与全部必填字段；签署后检查变为 success |
| 重新检查 | 已签署用户触发 recheck 后仍为 success，不重复生成签署记录 |
| 多提交者 PR | 每位非豁免提交者均满足要求后才能通过 |
| Gist 新修订 | 新 PR 要求重新签署；旧修订的签署人与历史贡献仍可审计 |
| Dependabot | 只在确认机器人无法签署且更新仍经 CI/评审后，显式导入 `dependabot[bot]` 豁免；不得使用通配豁免 |
| 仓库权限撤销 | CLA 检查失败可见且阻止合并，不得静默放行 |

测试完成后：

1. 从 CLA Assistant 导出测试签署记录，确认包含 GitHub 身份、自定义字段、协议
   修订和时间；随后按测试数据保留规则删除或隔离测试记录。
2. 把测试日期、PR URL、Gist revision、截图或检查结论写入私有合规仓库，不在
   公共仓库保存邮箱等个人数据。
3. 由另一位受控维护者复核分支规则，确认普通维护者不能绕过必需 CLA 检查。
4. 确认 `contact@okoklabs.com` 的收件责任人、响应频率、离职/失联交接和账号恢复
   方式已经记录在私有运维文档。

## 5. 激活

上述测试全部通过后，在同一个受保护变更中：

1. 把 `CLA.md` 状态改为 `ACTIVE`，写入正式版本、激活日期、Gist revision 和已
   验证的联系邮箱；移除所有未解决占位符。
2. 更新 `CONTRIBUTING.md`，明确外部版权性贡献必须通过 `license/cla`。
3. 更新开源准备清单并保存私有激活记录。
4. 激活提交合并后再宣布接受外部版权性贡献。

## 6. 日常与版本升级

- 每季度导出签署清单和 Gist 修订索引到访问受限的私有合规仓库；导出文件加密，
  备份和恢复演练与其他合规记录一致。
- 不在 Issue 中处理签署人的邮箱、法定姓名更正或雇主授权材料；转入已验证邮箱和
  私有记录。
- 协议变更先形成新候选版本并评审。记录旧版本适用范围，再更新 Gist，测试重新
  签署，最后修改必需版本；不要覆盖或丢弃旧签署导出。
- CLA Assistant 不可用时暂停合并外部版权性贡献。不得临时用 PR 勾选框、邮件
  “同意”或管理员绕过替代签署记录。

## 参考

- [CLA Assistant README](https://github.com/cla-assistant/cla-assistant)
- [CLA Assistant custom-fields schema](https://raw.githubusercontent.com/cla-assistant/cla-assistant/main/custom-fields-schema.json)
- [Harmony Agreements](https://www.harmonyagreements.org/)
- [GitHub rulesets documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
