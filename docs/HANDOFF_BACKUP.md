# AI / 维护者交接备份

本文说明如何把 OpenLabStock 的当前开发状态交给另一位维护者或 AI。它和数据库备份是两条不同的路径：

- `pnpm run backup`：保护实验室业务数据，生成经过 SQLite 一致性和完整性检查的 `.sqlite` 快照。
- `pnpm run handoff`：保护代码、完整 Git 历史、当前未提交改动和维护上下文，默认不携带业务数据。

## 为什么同时使用 bundle 和 archive

交接包同时保存两种成熟格式：

- `git/openlabstock.bundle`：由 `git bundle --all` 生成，包含本地仓库可见的完整 refs 和历史，适合离线恢复提交、分支和标签。
- `git/source.tar.gz`：由 `git archive HEAD` 生成，只包含指定提交的干净源码快照，适合快速浏览、代码审查或没有 Git 环境的接手者。

此外，交接包还保存：

- `worktree/changes.patch`：相对记录的 HEAD，当前已跟踪文件的暂存和未暂存改动；
- `worktree/index.patch` 与 `worktree/worktree.patch`：分别保存已暂存和未暂存改动，恢复时尽量还原原来的 Git 状态；
- `worktree/untracked/`：默认收集的非忽略未跟踪文件；
- `context/HANDOFF.md`：首读顺序、验证命令和恢复边界；
- `context/verification/`：本机已有的验证回执（若存在）；
- `README-FIRST.md` 与 `tools/handoff.mjs`：没有现成仓库时使用的离线入口和便携恢复工具；
- `handoff.json`：生成时间、分支、HEAD、版本、工作树状态、文件清单和安全边界；
- `checksums.sha256`：交接包内部每个文件的 SHA-256。

## 创建交接包

在仓库根目录运行：

```powershell
pnpm run handoff
```

默认输出到项目同级的 `openlabstock-backups/openlabstock-handoff-时间.tar.gz`，旁边同时生成同名 `.sha256` 文件。备份目录必须位于仓库之外，避免项目目录损坏、误删或再次打包时连备份一起受影响。传递交接包时应把两者一起传递；`inspect` 和 `restore` 发现旁置校验文件后会先验证整个压缩包，再验证包内每个文件。也可以指定其他磁盘：

```powershell
pnpm run handoff -- create --output "E:\handoff\openlabstock-handoff-20260902.tar.gz"
```

如果只想交接已提交内容和 Git 历史，不包含当前非忽略未跟踪文件：

```powershell
pnpm run handoff -- create --no-untracked
```

Linux/macOS 使用同一组命令。脚本会在打包前检查仓库根目录、HEAD、Git bundle、干净源码 archive 和路径安全性，并在包内写入校验清单；归档先写入临时文件，验证完成后才原子改名，已经存在的同名包不会被覆盖。

Windows 维护者也可以双击仓库根目录的 `handoff-backup.cmd`。它只调用同一个 `pnpm run handoff`，不会维护第二套备份逻辑。

## 交给别人或 AI 前先检查

交接包包含完整 Git 历史。即使默认排除了数据库和环境文件，历史提交仍可能包含不适合外传的内容。因此：

1. 只把交接包交给可信的维护者或受控的 AI 工作区。
2. 对外公开前，先审查 `git bundle` 的全部历史；发现密钥、个人资料或生产信息时，使用专门的历史清理流程，不能只删除当前文件。
3. 不要把交接包上传到公开 Issue、公开 Gist、聊天附件或未经确认的第三方存储。
4. 业务数据库、`.env`、日志、`node_modules`、构建缓存、SQLite WAL 文件和备份目录默认不会进入交接包。

交接元数据只保留 remote 的名称、传输协议和主机，仓库路径、账号和凭据会被脱敏；恢复后如需继续推送，请由接手者在确认权限后手动重新添加远端。

## 查看交接包

在不恢复文件的情况下验证内部清单并查看元数据：

```powershell
pnpm run handoff:inspect -- "E:\handoff\openlabstock-handoff-20260902.tar.gz"
```

`inspect` 会先检查归档路径安全性，再验证 `handoff.json` 和 `checksums.sha256`。校验失败时不会继续恢复。

如果新电脑只有交接包且暂时不能访问 GitHub，可先把便携工具解出到空目录，再用它验包和恢复：

```powershell
New-Item -ItemType Directory -Path .\handoff-tool
tar -xzf .\openlabstock-handoff-20260902.tar.gz -C .\handoff-tool README-FIRST.md tools/handoff.mjs
node .\handoff-tool\tools\handoff.mjs inspect .\openlabstock-handoff-20260902.tar.gz
node .\handoff-tool\tools\handoff.mjs restore .\openlabstock-handoff-20260902.tar.gz --target .\openlabstock-restored
```

便携工具只使用 Node.js 内置模块以及系统中的 `git`、`tar`，不需要先安装项目依赖。外层 `.sha256` 可以发现传输损坏，但不能证明发送者身份；仍应通过可信渠道核对哈希或文件来源。

## 在新电脑恢复代码

恢复必须指向新建或空目录，工具不会覆盖已有非空目录：

```powershell
pnpm run handoff:restore -- "E:\handoff\openlabstock-handoff-20260902.tar.gz" --target "C:\Work\openlabstock-handoff"
```

恢复过程为：

1. 验证交接包中每个文件的 SHA-256；
2. 初始化 Git 并从 bundle 恢复 refs、分支和提交；
3. 检出交接时记录的 HEAD；
4. 应用 `index.patch` 和 `worktree.patch`，恢复已暂存和未暂存改动；
5. 复制非忽略未跟踪文件；
6. 在目标目录写入 `.handoff/HANDOFF.md`、状态摘要、验证回执和 `.handoff/handoff.json`，并将 `.handoff/` 写入该仓库的本地 Git exclude，不污染工作树。

恢复完成后，接手者按下面顺序继续：

```powershell
cd "C:\Work\openlabstock-handoff"
Get-Content .handoff\HANDOFF.md
pnpm install --frozen-lockfile
pnpm run verify:auto
```

如果交接时工作树有改动，恢复后的 `git status` 应保留这些改动；这不是恢复失败，而是为了让接手者看到未提交工作仍然存在。

## 业务数据库如何迁移

`handoff` **不会自动恢复数据库**。数据库包含账号、密码哈希、成员、库存和完整流水，不能跟源码包一起交给不可信的接手者。

源实例使用现有一致性备份流程：

```powershell
$env:DATA_DIR = 'D:\OpenLabStock-data'
$env:BACKUP_DIR = 'E:\OpenLabStock-backups'
$env:BACKUP_RETENTION_DAYS = '30'
pnpm run backup
```

该脚本使用 SQLite `VACUUM INTO`，然后执行 `PRAGMA integrity_check`。迁移到新实例时，应先停止连接同一数据库的其他 Node 进程，再用已验证的 `.sqlite` 快照按公开的 [`DEPLOYMENT.md`](../DEPLOYMENT.md) 和受限环境自己的运维手册恢复。不要直接复制正在运行的 `labstock.sqlite`，也不要只迁移某几张表。

推荐的完整交接顺序是：

1. 创建并检查代码交接包；
2. 单独创建并验证数据库快照（仅在确有业务接手需要时）；
3. 通过受控渠道分别传递两个文件；
4. 在隔离目录恢复代码，在隔离实例恢复数据库；
5. 核对成员、所有权、库存、流水和权限后，再决定是否切换正式服务。

建议在大改动或正式发布前生成一次交接包，把最新包和 `.sha256` 再复制到另一块磁盘或受保护存储，并定期在空目录做恢复演练。GitHub 是日常协作与远程来源，但不能替代未提交工作树和独立离线备份。

## 与发布包的区别

交接包用于继续开发和排障，不是生产部署包：

- 交接包保留完整 Git 历史、补丁和维护上下文；
- Release 生产包只包含经过验证的运行文件和部署文档，不包含 `.git`、数据库或本机验证凭据；
- 生产更新仍使用固定版本 Release、manifest、部署前数据库备份和失败回滚流程。

这样既能让 AI 或新维护者无缝接手，又不会把一次内部交接误当成公开发行或数据库迁移。

## 参考

- [Git 官方 `git bundle` 文档](https://git-scm.com/docs/git-bundle)：说明 `--all` 备份 refs、离线克隆与 `bundle verify`，并明确 bundle 不保存 index、working tree、仓库配置和 hooks。
- [Git 官方 `git archive` 文档](https://git-scm.com/docs/git-archive)：说明如何从指定 commit 或 tag 生成干净源码树。
- [Git 官方 `git clone` 文档](https://git-scm.com/docs/git-clone)：说明从独立仓库或 bundle 恢复时的 refs 与远端行为，以及备份场景避免依赖源仓库对象的注意事项。
