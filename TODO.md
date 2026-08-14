# OpenLabStock 短期待办

本文件只保存公共仓库当前 5-10 个可执行事项。超过一个迭代、需要多人协作或需要公开讨论的事项应转为 GitHub Issue；长期方向进入 [`ROADMAP.md`](./ROADMAP.md)，已发布变化进入 [`CHANGELOG.md`](./CHANGELOG.md)。

## Now

- [ ] `[PUBLIC]` 完成首次公开门禁：复核代码与品牌权利链，专业复核并定稿个人 CLA，启用并测试 CLA Assistant、分支规则和 GitHub Private Vulnerability Reporting。
- [ ] `[PUBLIC]` 配置并测试 `conduct@okoklabs.com` 后，移除行为准则中的待启用说明。
- [ ] `[PUBLIC]` 在全新 Linux 环境从本仓库完成安装、构建、空库启动、旧库升级、备份、恢复和回滚演练。
- [ ] `[PUBLIC]` 在具备 Docker Engine 的 Linux 环境运行 `bash deploy/docker/openlabstock.sh smoke`，确认 Compose 不连接任何正式卷。
- [ ] `[PUBLIC]` 逐领域拆分前端、API 路由和测试，每次只迁移一个边界并保持现有 API 行为。

## Manual Verification

- [ ] 在 Android Chrome 和 iOS Safari 验收 PWA 安装、版本更新、登录保持和断网不重放写请求。
- [ ] 验收二维码后置摄像头、拒绝后重新授权、后台切换和关闭弹窗后的摄像头释放。
- [ ] 在目标 Android 浏览器与常用输入法复测弹窗：输入法打开后底边贴合、遮罩完整、背景不滚动；收起后恢复安全区和圆角。

## 维护规则

- 新需求先分类，不得因插入新事项而遗忘仍未交付的问题。
- 完成意味着实现、相应风险级验证和必要的实际界面或设备检查均已完成。
- 已完成事项从本文件删除；用户可感知变化写入 `CHANGELOG.md`，重要决策进入 Roadmap、Issue 或 ADR。
- 安全漏洞不进入普通公开 Issue，按 [`SECURITY.md`](./SECURITY.md) 私下报告。
