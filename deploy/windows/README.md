# Windows 运维向导

`OpenLabStock-Operations.cmd` 是面向 Windows 维护者的双击入口，用于连接一台已经安装好 OpenLabStock 的 Linux/systemd 实例。它把常用操作收敛为一个菜单：

1. 构建并更新
2. 备份数据库
3. 生成代码交接包
4. 回滚到最近的程序版本
5. 查看状态
6. 检查部署是否就绪
7. 修改连接配置
8. 清理超过 30 天的旧程序目录

## 使用前

- Windows 已启用 **OpenSSH Client**，可在 PowerShell 中运行 `ssh -V` 和 `scp -V` 检查；
- 本机已安装 Node.js `>=22.12.0`；
- 仓库依赖已安装。若 `pnpm` 不在 PATH，向导会自动尝试仓库声明的 Corepack 版本；也可以先运行 `corepack enable pnpm`；
- 服务器已经完成一次 systemd 部署，并且生产包中的 `deploy/systemd/update-openlabstock.sh` 已安装到服务器；
- 维护账号具有上传文件、执行更新脚本和操作 systemd 的权限。推荐使用 SSH 密钥；使用密码时，`scp` 和 `ssh` 可能各询问一次密码，密码不会写入文件。

## 双击使用

双击：

```text
deploy\windows\OpenLabStock-Operations.cmd
```

首次运行时输入：

- SSH 目标，例如 `maintainer@inventory.example.org`；只输入主机名或 IP 时，向导默认使用 `root@主机`；
- SSH 端口；
- 标准目录确认；如果服务器沿用 `/opt/openlabstock`、`/var/lib/openlabstock` 和 `openlabstock.service`，直接接受默认值即可；
- 非标准部署才需要继续填写服务器上的程序、数据、环境、备份目录、systemd 服务名和更新脚本路径；
- 可选的公网 `/api/health` 地址。

这些非敏感配置保存在当前 Windows 用户的：

```text
%LOCALAPPDATA%\OpenLabStock\operations.json
```

文件不保存密码、私钥、数据库或生产包。删除该文件即可重新填写服务器配置。

首次配置后，普通操作会直接复用已保存的连接信息，不会每次重复询问目录。需要更换服务器或修正路径时，在菜单选择“修改连接配置”。“检查部署是否就绪”会检查 systemd、程序目录、数据目录、环境文件、Node.js 和最近备份；旧版服务器如果还没有该命令，会退回显示状态，不会阻塞维护。

“生成代码交接包”是本机项目操作，不连接服务器。它调用仓库唯一的 `pnpm run handoff`，在项目同级的 `openlabstock-backups/` 生成带 `.sha256` 的交接包，包含 Git 历史、源码快照、文档、当前未提交改动和恢复说明；默认排除数据库、`.env`、日志、`node_modules`、构建缓存和凭据。它和“备份数据库”是两件事，接手者若确实需要业务数据，必须通过受控渠道单独传递已验证的 SQLite 备份。

## 更新流程

选择“构建并更新”后：

1. 输入已有生产包路径；或留空，让向导递增版本、运行发布验证并生成生产包和 manifest；
2. 向导只接受 `OpenLabStock-production-YYYYMMDD-rN.tar.gz` 及同版本 manifest；
3. 先创建远程临时目录并上传两个文件；
4. 服务器脚本先做 SQLite 一致性备份，再校验 manifest、解包、原子切换和健康检查；
5. 成功后清理远程临时目录；失败时保留服务器的失败程序目录，方便排查和回滚。

向导不会执行任意服务器命令，也不会移动 `/var/lib/openlabstock`。更新时优先使用上传包内经过校验的新辅助脚本，因此旧服务器即使还不认识 `--manifest` 也能升级；回滚只切换程序目录，不恢复数据库。

## 服务器端动作

菜单中的备份、回滚、状态、就绪检查和清理分别调用固定的 systemd 更新脚本动作：

```bash
backup
rollback
status
doctor
prune 30 --yes
```

每个动作都使用同一个锁，避免更新、回滚和备份并发操作。需要恢复数据库时，仍使用网页的系统所有者二次授权流程或正式的 SQLite 恢复手册，不把数据库恢复放进“一键回滚”。

## 安全边界

- 不要把 `operations.json`、SSH 私钥或生产 manifest 提交到 Git；
- 服务器应使用独立维护账号，生产环境更推荐 SSH 密钥和受限 `sudo`，而不是长期使用 root 密码；
- 第一次使用后核对本地与公网 `/api/health`、网页侧栏版本和服务器 `package.json`；
- 自动化降低的是复制命令的错误，不替代发布包 SHA-256、数据库备份和健康检查。
