# systemd 首次安装、更新与回滚

本目录提供单台 Linux 服务器上的 Node.js + systemd 首次安装、更新和回滚脚本。脚本只切换程序目录；SQLite 数据和备份目录必须位于程序目录之外，因此不会被发布包覆盖。

## 默认目录

```text
程序：/opt/openlabstock
数据：/var/lib/openlabstock
服务：openlabstock.service
端口：127.0.0.1:4388
```

脚本也会根据 systemd 中包含 Node `server.mjs` 的服务，自动读取其工作目录和环境文件。这能覆盖保留旧服务名称的迁移实例。生产环境建议显式指定变量，避免误切换到另一套实例：

```bash
export OPENLABSTOCK_APP_DIR=/opt/openlabstock
export OPENLABSTOCK_SERVICE_NAME=openlabstock
export OPENLABSTOCK_DATA_DIR=/var/lib/openlabstock
export OPENLABSTOCK_ENV_FILE=/etc/openlabstock/openlabstock.env
export OPENLABSTOCK_BACKUP_DIR=/var/lib/openlabstock/backups
```

脚本需要 root 权限、`curl`、`tar`、`sha256sum`、`flock`、`node` 和 systemd。它不需要 pnpm，也不会从 GitHub 自动下载文件。先上传已经在本地验证过的生产包，再执行更新。

## 新服务器首次安装

先从 GitHub Release 下载同版本的生产包和 manifest，再把两个文件上传到服务器。首次安装脚本会创建 `openlabstock` 系统账号、数据目录、环境文件、systemd 服务和更新辅助脚本；它不会覆盖已有实例：

```bash
sudo bash deploy/systemd/install-openlabstock.sh \
  --package /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.tar.gz \
  --manifest /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.manifest.txt
```

没有提供初始密码时，脚本会在终端中询问；直接回车会生成一次性密码并只显示一次。首次登录并修改密码后，应从 `/etc/openlabstock/openlabstock.env` 删除 `INITIAL_ADMIN_PASSWORD`。如果服务已经存在，请改用下面的 `update`，不要再次运行首次安装。

## 更新

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh \
  update /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.tar.gz \
  --manifest /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.manifest.txt
```

执行顺序是：读取并校验 manifest 的归档文件名、版本和 SHA-256，校验生产包内容，在当前版本上生成 SQLite 一致性备份，解包并检查 Node 语法，停止服务后原子切换程序目录，最后等待本地 `/api/health` 返回候选版本。也可以继续使用 `--sha256 HASH`；同时传入两者时必须一致。

备份、解包、切换或健康检查任一步失败时，脚本会自动恢复上一程序目录，重启服务，并将失败目录保留为 `*-failed-*` 供排查。失败不会删除数据库或旧版本。

`OPENLABSTOCK_PUBLIC_HEALTH_URL` 可选。设置后本地检查通过还会额外检查公网 HTTPS 健康地址。

## 独立备份

如果只需要备份而不更新程序：

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh backup
```

该动作使用同一把更新锁和 SQLite 一致性备份流程，但不会停止服务、切换程序目录或修改数据库内容。

## 查看、回滚和清理

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh status
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh doctor
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh rollback
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh prune 30 --yes
```

不带目录参数时，`rollback` 选择最近一个完整的 `*-previous-*` 目录，也可以直接指定目录。回滚只切换程序，不自动恢复数据库；数据库恢复应使用已验证的 SQLite 备份并先停止所有连接数据库的进程。`prune` 至少保留 7 天且必须显式确认，只删除程序目录旁的旧版本和失败目录。

不要把数据库、`.env`、日志或备份放进发布包；不要同时运行原生 systemd 和 Docker 两个可写实例；更新失败时先看 `journalctl -u openlabstock -n 120 --no-pager`。
