# systemd 更新与回滚

本目录提供单台 Linux 服务器上的 Node.js + systemd 更新脚本。脚本只切换程序目录；SQLite 数据和备份目录必须位于程序目录之外，因此不会被发布包覆盖。

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

## 更新

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh \
  update /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.tar.gz \
  --sha256 PUBLISH_MANIFEST_SHA256
```

执行顺序是：校验 SHA-256 和生产包内容，在当前版本上生成 SQLite 一致性备份，解包并检查 Node 语法，停止服务后原子切换程序目录，最后等待本地 `/api/health` 返回候选版本。

备份、解包、切换或健康检查任一步失败时，脚本会自动恢复上一程序目录，重启服务，并将失败目录保留为 `*-failed-*` 供排查。失败不会删除数据库或旧版本。

`OPENLABSTOCK_PUBLIC_HEALTH_URL` 可选。设置后本地检查通过还会额外检查公网 HTTPS 健康地址。

## 查看、回滚和清理

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh status
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh rollback
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh prune 30 --yes
```

不带目录参数时，`rollback` 选择最近一个完整的 `*-previous-*` 目录，也可以直接指定目录。回滚只切换程序，不自动恢复数据库；数据库恢复应使用已验证的 SQLite 备份并先停止所有连接数据库的进程。`prune` 至少保留 7 天且必须显式确认，只删除程序目录旁的旧版本和失败目录。

不要把数据库、`.env`、日志或备份放进发布包；不要同时运行原生 systemd 和 Docker 两个可写实例；更新失败时先看 `journalctl -u openlabstock -n 120 --no-pager`。
