# OpenLabStock 部署指南

本文提供不依赖特定实验室、服务器或域名的部署基线。示例域名 `inventory.example.org` 必须替换为操作者自己的域名。不要把生产凭据、数据库或真实服务器清单写入仓库。

代码交接、Git 历史离线恢复和未提交工作树迁移见 [AI / 维护者交接备份](./docs/HANDOFF_BACKUP.md)；它不替代下面的 SQLite 业务数据备份。

## 运行模型

OpenLabStock 由两个部分组成：

- Astro 构建到 `dist/` 的浏览器前端；
- `server.mjs` 提供 Node API，并通过 `storage.mjs` 访问 SQLite。

默认端口为 `4388`。生产环境建议保持单个 Node 进程，只监听 `127.0.0.1:4388`，再由 Caddy、Nginx 或其他受控反向代理提供 HTTPS。

## 获取固定版本

正式部署使用 [GitHub Releases](https://github.com/okoklabs/openlabstock/releases) 中同一标签的生产包和 manifest，不直接部署 `main`。在 Release 页面复制版本标签，然后下载并校验：

```bash
RELEASE=YYYYMMDD-rN
ARCHIVE="OpenLabStock-production-${RELEASE}.tar.gz"
MANIFEST="OpenLabStock-production-${RELEASE}.manifest.txt"
BASE_URL="https://github.com/okoklabs/openlabstock/releases/download/${RELEASE}"

curl --fail --location --remote-name "${BASE_URL}/${ARCHIVE}"
curl --fail --location --remote-name "${BASE_URL}/${MANIFEST}"
EXPECTED="$(sed -n 's/^sha256: //p' "$MANIFEST")"
test -n "$EXPECTED"
printf '%s  %s\n' "$EXPECTED" "$ARCHIVE" | sha256sum --check -
```

只有看到校验结果为 `OK` 才继续解压。生产包不包含数据库、备份、环境变量或账号信息。

## 本机运行

要求 Node.js `>=22.12.0` 与仓库声明的 pnpm 版本：

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

打开 <http://127.0.0.1:4388/>。本机试用不需要先执行完整测试、许可证检查或依赖审计；这些属于贡献和发布门禁。本机开发数据默认写入 `data/`，该目录已被 Git 忽略。

## 生产目录

推荐把程序和数据分离：

```text
/opt/openlabstock                 # 只读应用程序，可随版本替换
/var/lib/openlabstock             # SQLite 数据和受控备份，不随发布替换
/etc/openlabstock/openlabstock.env # 环境变量，权限 600
```

创建专用系统账号和目录：

```bash
sudo useradd --system --home-dir /opt/openlabstock --shell /usr/sbin/nologin openlabstock
sudo install -d -o root -g root -m 755 /opt/openlabstock
sudo install -d -o openlabstock -g openlabstock -m 700 /var/lib/openlabstock
sudo install -d -o root -g root -m 755 /etc/openlabstock
sudo install -o root -g openlabstock -m 640 deploy/openlabstock.env.example /etc/openlabstock/openlabstock.env
```

至少设置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4388
DATA_DIR=/var/lib/openlabstock
BACKUP_DIR=/var/lib/openlabstock/backups
INSTANCE_ID=example-lab-prod
INITIAL_ADMIN_PASSWORD=replace-with-a-unique-long-password
TRUST_PROXY=1
COOKIE_SECURE=1
# Optional; only a private control plane should send this header.
HEALTH_DETAIL_TOKEN=replace-with-a-random-secret
```

`INITIAL_ADMIN_PASSWORD` 只用于空库创建第一个系统所有者。首次启动成功并修改密码后，应从环境文件移除该明文值。

## systemd

完整构建或生产包解压到 `/opt/openlabstock` 后：

```bash
sudo cp /opt/openlabstock/deploy/openlabstock.service /etc/systemd/system/openlabstock.service
sudo systemctl daemon-reload
sudo systemctl enable --now openlabstock
sudo systemctl --no-pager --full status openlabstock
curl --fail --show-error http://127.0.0.1:4388/api/health
```

服务以无登录权限的 `openlabstock` 用户运行，只允许写入数据目录。

普通健康地址只证明应用存活。若要供私有实例控制面检查数据库结构和最近备份，配置
`INSTANCE_ID` 与 `HEALTH_DETAIL_TOKEN` 后使用授权请求；响应不包含库存、成员或流水内容：

```bash
curl --fail --show-error \
  -H 'X-OpenLabStock-Health-Token: replace-with-a-random-secret' \
  'http://127.0.0.1:4388/api/health?detail=1'
```

详细检查会返回应用版本、实例 ID、SQLite 完整性、结构版本、数据库大小和最近备份清单状态。

### 自动更新与回滚

生产包包含 [`deploy/systemd/update-openlabstock.sh`](./deploy/systemd/update-openlabstock.sh)。
它会先生成 SQLite 一致性备份，再校验压缩包、原子切换程序目录并等待候选版本的健康检查；
启动或健康检查失败时自动恢复上一程序目录，并保留失败目录供排查：

```bash
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh \
  update /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.tar.gz \
  --manifest /home/maintainer/OpenLabStock-production-YYYYMMDD-rN.manifest.txt
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh status
sudo bash /opt/openlabstock/deploy/systemd/update-openlabstock.sh rollback
```

回滚只切换程序，不自动恢复数据库；确认稳定后可用 `prune 30 --yes` 清理超过 30 天的旧程序目录。

Windows 维护者可以双击 [`deploy/windows/OpenLabStock-Operations.cmd`](./deploy/windows/OpenLabStock-Operations.cmd)，用菜单执行更新、独立备份、回滚、状态和旧程序清理。首次运行填写 SSH 目标和服务器目录后，非敏感配置会保存到当前 Windows 用户的 `%LOCALAPPDATA%\OpenLabStock\operations.json`；密码不会保存。向导仍要求校验 manifest，并调用服务器上的同一个原子更新脚本，不会自行拼接任意远程命令。

## HTTPS 反向代理

[`deploy/Caddyfile.example`](./deploy/Caddyfile.example) 提供最小 Caddy 片段。只把片段合并到操作者自己的配置，不要用示例覆盖已有 Caddyfile：

```caddyfile
www.inventory.example.org {
    redir https://inventory.example.org{uri} permanent
}

inventory.example.org {
    reverse_proxy 127.0.0.1:4388
}
```

修改后先验证配置，再平滑加载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail --show-error https://inventory.example.org/api/health
```

不得直接把 Node 端口暴露到公网。登录和摄像头扫码需要 HTTPS；局域网明文 HTTP 只适合受控测试环境。

## Docker

Docker 路线见 [`deploy/docker/README.md`](./deploy/docker/README.md)。默认 Compose 也只绑定 `127.0.0.1:4388`，数据库卷和备份卷独立持久化，并使用单个 `app` 实例。

## 备份和恢复

一致性备份：

```bash
sudo -u openlabstock env \
  DATA_DIR=/var/lib/openlabstock \
  BACKUP_DIR=/var/lib/openlabstock/backups \
  /usr/bin/node /opt/openlabstock/scripts/backup.mjs
```

备份必须同步到另一台机器、对象存储或独立磁盘；同一服务器上的第二份文件不能覆盖整机故障。定期执行恢复演练，不能只确认备份文件存在。

网页数据库恢复仅适用于单个 Node/systemd 实例。恢复前必须一致性备份、确认没有第二个写进程，并使用系统所有者密码完成二次授权。

## 所有者密码恢复

只有具有服务器和数据目录权限的维护人员可以运行：

```bash
sudo -u openlabstock env DATA_DIR=/var/lib/openlabstock \
  /usr/bin/node /opt/openlabstock/scripts/reset-owner-password.mjs
```

工具生成临时密码并清空现有会话，不修改成员 UUID、库存或流水。登录后立即设置新密码。

## 更新原则

1. 先运行发布要求的完整验证并生成一致性备份。
2. 把新版本解压到独立暂存目录，不在数据目录内解压。
3. 停止服务，原子切换 `/opt/openlabstock`，再启动并等待两秒。
4. 检查本地和公网 `/api/health`、网页侧栏版本与 `package.json` 一致。
5. 健康检查失败时只回滚程序目录，不删除或覆盖数据目录。

发布包契约见 [`deploy/PRODUCTION.md`](./deploy/PRODUCTION.md)。
