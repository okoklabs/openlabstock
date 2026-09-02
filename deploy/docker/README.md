# OpenLabStock Docker 部署

该方案面向一台 Linux 服务器、一个 OpenLabStock 应用实例和本地 SQLite。Docker 负责应用进程、权限、健康检查和持久卷；宿主机上的 Caddy 或等效反向代理负责域名与 HTTPS。

## 设计边界

- 默认只映射 `127.0.0.1:4388`，不占用 `80/443`，不会覆盖宿主机已有的 Caddy 站点配置。
- 使用默认 Compose 项目名时，数据库与备份分别保存在 Docker 命名卷 `openlabstock_openlabstock_data`、`openlabstock_openlabstock_backups`，重建容器不会删除数据。
- 只有一个 `app` 服务，不允许用 `--scale` 启动多个写实例。网页数据库恢复前也不能有第二个进程连接 SQLite。
- 容器使用 Node 官方 Debian slim 镜像、非 root `node` 用户、只读根文件系统、`init`、健康检查、能力清空和日志轮转。
- `down` 命令不会带 `--volumes`。不要执行 `docker compose down -v`，它会删除库存数据库卷。

## 首次安装

服务器先按 Docker 官方文档安装 Docker Engine 与 Compose v2 插件。从 [GitHub Releases](https://github.com/okoklabs/openlabstock/releases) 下载同一标签的生产包和 manifest，并按根目录 [`DEPLOYMENT.md`](../../DEPLOYMENT.md#获取固定版本) 校验 SHA-256。把生产包解压到独立目录，例如 `/opt/openlabstock-docker`，然后运行：

```bash
cd /opt/openlabstock-docker
bash deploy/docker/openlabstock.sh init
```

脚本会自动：

1. 检查 Docker 与原生 `openlabstock.service` 冲突。
2. 生成权限为 `600` 的 `.env` 和随机初始密码。
3. 使用锁文件分阶段构建镜像。
4. 创建数据卷、启动容器并等待 `/api/health`。
5. 数据库初始化后清除 `.env` 中的明文密码，再重建一次容器。
6. 显示首次登录的 `admin` 账号和密码。

登录后立即修改所有者密码。以后不要再次运行 `init`。

## Caddy

宿主机 `/etc/caddy/Caddyfile` 保持：

```caddyfile
www.inventory.example.org {
    redir https://inventory.example.org{uri} permanent
}

inventory.example.org {
    encode gzip zstd
    reverse_proxy 127.0.0.1:4388
}
```

验证并重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail --show-error https://inventory.example.org/api/health
```

## 日常命令

```bash
bash deploy/docker/openlabstock.sh status
bash deploy/docker/openlabstock.sh logs
bash deploy/docker/openlabstock.sh backup
bash deploy/docker/openlabstock.sh update
bash deploy/docker/openlabstock.sh rollback
bash deploy/docker/openlabstock.sh down
bash deploy/docker/openlabstock.sh smoke
```

`backup` 先在备份卷内执行 SQLite `VACUUM INTO` 和完整性检查，再复制一份到宿主机 `backup-exports/`。应继续把该目录同步到另一台机器或对象存储。

`update` 会先备份并把当前镜像标记为 `openlabstock:rollback`，然后构建新镜像并等待健康检查。构建失败不会影响正在运行的旧容器；切换失败时执行 `rollback`。数据库升级前的备份仍是最终恢复依据。

`smoke` 使用随机 Compose 项目名、随机回环端口和独立临时卷，自动检查镜像构建、首次登录、非 root/只读根目录、数据持久化、备份导出、模拟更新和镜像回滚。它不会读取或修改正式卷，成功或失败都会清理自己的测试容器、网络和卷。建议在首次正式部署前和 Docker/Compose 大版本升级后运行一次。

## 从原生 systemd 迁移

1. 在原服务运行时执行一次一致性备份，并把生成的 `.sqlite` 下载到安全位置。
2. 停止并禁用原生服务：`sudo systemctl disable --now openlabstock`。
3. 运行 Docker `init`，确认新站健康。
4. 使用新站“系统设置 -> 数据管理”上传第 1 步备份并恢复。
5. 重新登录，核对成员、耗材、库存、流水、组织和版本。
6. 保留 `/var/lib/openlabstock` 一段时间，不要立刻删除原数据库。

恢复时只保留一个可写服务。不能让 systemd 原生服务与 Docker 容器同时监听或同时修改同一份业务数据。

## 直接通过 IP 使用 HTTP

默认仅供 Caddy 在本机访问。确实需要通过 `http://服务器IP:4388` 登录时，在 `.env` 中设置：

```dotenv
OPENLABSTOCK_BIND_IP=0.0.0.0
COOKIE_SECURE=0
```

然后运行 `bash deploy/docker/openlabstock.sh up`。公网 HTTP 会明文传输账号和密码，优先使用 HTTPS；同时只在主机防火墙或云安全组中开放可信来源地址。

## 资源与备份

默认限制为 1 个 CPU、512 MB 内存，适合小型单实例部署。若网页数据库恢复的文件接近 100 MB 或数据规模明显增加，可在 `.env` 提高 `OPENLABSTOCK_MEMORY_LIMIT`。

每天自动备份可由宿主机 cron 调用：

```cron
15 3 * * * cd /opt/openlabstock-docker && bash deploy/docker/openlabstock.sh backup >> /var/log/openlabstock-docker-backup.log 2>&1
```

Docker 卷不是异机备份。磁盘或服务器损坏时，同一磁盘上的数据卷与备份卷可能一起丢失。

## 参考规范

- Docker Build best practices: https://docs.docker.com/build/building/best-practices/
- Docker volumes: https://docs.docker.com/engine/storage/volumes/
- Docker Compose startup order and health checks: https://docs.docker.com/compose/how-tos/startup-order/
- Node.js Docker best practices: https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
