# CLA Assistant 启用与验收

本文是 `okoklabs/openlabstock` 使用托管版
[CLA Assistant](https://cla-assistant.io/) 的操作与维护记录。它不替代
[`CLA.md`](../CLA.md) 的法律审查，也不保存任何签署人的个人数据。

## 技术配置原则

CLA Assistant 已由组织 Owner 账号连接到公共仓库，并配置
`pull_request` 与 `merge_group` 事件监听。协议 Gist 的 URL、revision 和文件
哈希只保存在受限的私有合规记录中，不写入公共仓库。个人 CLA v1.0 已于
2026-09-03 激活；外部版权性贡献必须通过 `license/cla` 和质量 CI。

## 1. 启用门槛

以下项目必须全部完成：

- [x] 联系地址、收件责任人和回复路径已通过站外投递、垃圾邮件检查和账号恢复
  演练；实际收件箱不得写入 Git。
- [x] `okoklabs/openlabstock` 已从审查后的干净工作树建立并完成公开仓验收。
- [x] 项目负责人已确认公开身份为 `郝春霖 (Hao Chunlin)`，私有合规记录保存必要
  的身份和权利链证据。
- [x] 熟悉中国大陆适用法律的专业人士复核个人 CLA，包括已补入的准据法和争议
  处理条款，并将候选版本冻结为正式 `1.0`。
- [x] CLA Assistant 当时的隐私说明、服务状态和数据导出能力已经复核。
- [x] 组织贡献暂不接受；确有公司贡献需求时另行制定 Entity CLA。

上述门槛已完成。组织贡献仍不在个人 CLA 范围内，不能通过个人签署替代 Entity CLA。

## 2. 准备协议 Gist

1. 从已激活的 `CLA.md` 复制**正式协议正文**到一个 GitHub Gist 文件。不要复制
   状态记录或本页操作说明。
2. 在同一 Gist 增加名为 `metadata` 的文件，内容必须与
   [`.github/cla/metadata.json`](../.github/cla/metadata.json) 的已复核版本一致。
   CLA Assistant 要求文件名是 `metadata`，不是 `metadata.json`。
3. 在私有合规记录中保存 Gist URL、Gist revision SHA、协议版本、协议文件
   SHA-256、metadata SHA-256、复核人和冻结时间。不要把签署人导出表放入公共 Gist
   或公共仓库。
4. Gist 只承载已经冻结的协议。拼写修正也会形成新修订，并可能触发重新签署；先在
   仓库正式文件中评审，再更新 Gist。

CLA Assistant 的自定义字段格式以其官方
[JSON Schema](https://raw.githubusercontent.com/cla-assistant/cla-assistant/main/custom-fields-schema.json)
为准。本项目要求法定姓名、联系邮箱、三项资格确认和境外处理单独同意，不收集家庭
住址、证件号码、电话或雇主名称。

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

## 4. 验收记录

已完成的测试与当前证据：

| 场景 | 预期结果 |
| --- | --- |
| 未签署 | PR #10 曾显示 `license/cla` pending，随后阻止合并 |
| 完成签署 | PR #10 签署后 `license/cla` 变为 success 并完成合并 |
| 质量 CI | PR #10 的 `verify` 与 `smoke` 均通过 |
| Gist 新修订 | 正式 Gist 更新后由首个外部贡献者复核重新签署提示；旧修订记录保留 |
| 组织贡献 | 个人 CLA 不覆盖公司、学校或其他组织所有的贡献，需另行 Entity CLA |
| 权限门禁 | 激活变更将同时加入 `license/cla` 和 `verify` 必需检查 |

测试完成后：

1. 从 CLA Assistant 导出测试签署记录，确认包含 GitHub 身份、自定义字段、协议
   修订和时间；随后按测试数据保留规则删除或隔离测试记录。
2. 把测试日期、PR URL、Gist revision、截图或检查结论写入私有合规仓库，不在
   公共仓库保存邮箱等个人数据。
3. 由另一位受控维护者复核分支规则，确认普通维护者不能绕过必需 CLA 检查。
4. 确认 `contact@okoklabs.com` 的收件责任人、响应频率、离职/失联交接和账号恢复
   方式已经记录在私有运维文档。

## 5. 激活后的维护

1. `CLA.md` 已改为 `ACTIVE`，写入正式版本和激活日期；Gist revision、签署记录
   和联系地址的验收证据继续只保存在私有合规记录。
2. `CONTRIBUTING.md` 已明确外部版权性贡献必须通过 `license/cla`。
3. 每次协议修订先形成新候选版本、更新 Gist、完成重新签署测试，再改变必需版本。
4. 激活提交合并后，才宣布接受外部版权性贡献；在此之前仍按 PR 门禁处理。

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
