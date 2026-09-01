# OpenLabStock 宣传页部署笔记

本文记录 `openlabstock.com` 静态宣传页的部署与维护方法。文档不保存真实服务器 IP、SSH 用户名或凭据，执行命令时自行替换占位符。

## 当前部署约定

| 项目 | 约定 |
| --- | --- |
| 主域名 | `https://openlabstock.com` |
| `www` 域名 | 永久跳转到主域名 |
| 本地源码 | `openlabstock-landing/` |
| 服务器网页目录 | `/var/www/openlabstock` |
| 独立 Caddy 配置 | `/etc/caddy/sites/openlabstock.caddy` |
| Caddy 主配置 | `/etc/caddy/Caddyfile` |
| 应用运行时 | 无；纯 HTML、CSS、JavaScript 静态站点 |
| HTTPS | 由 Caddy 自动申请和续期证书 |

服务器需要允许公网访问 TCP `80` 和 `443`。DNS 中，根域名的 `A` 记录指向服务器公网 IPv4，`www` 使用指向根域名的 `CNAME`。

## 首次准备网页目录

登录服务器：

```bash
ssh <SSH_USER>@<SERVER_IP>
```

创建独立网页目录并确保 Caddy 可读取：

```bash
sudo mkdir -p /var/www/openlabstock
sudo chmod -R a+rX /var/www/openlabstock
```

网页目录中应直接包含：

```text
/var/www/openlabstock/index.html
/var/www/openlabstock/styles.css
/var/www/openlabstock/script.js
/var/www/openlabstock/assets/
```

## Caddy 详细配置教程

Caddy 在这里负责三件事：

1. 收到访问 `openlabstock.com` 的请求。
2. 从 `/var/www/openlabstock` 读取静态网页并返回给浏览器。
3. 自动申请、安装和续期 HTTPS 证书。

配置由两个文件组成：

```text
/etc/caddy/Caddyfile
└── import /etc/caddy/sites/*.caddy
    └── /etc/caddy/sites/openlabstock.caddy
```

主 `Caddyfile` 继续管理服务器上的全部网站；`openlabstock.caddy` 只管理当前宣传页。这样修改 OpenLabStock 时，不需要动其他网站的配置块。

### 第 1 步：登录服务器

在本机 PowerShell 或终端执行：

```bash
ssh <SSH_USER>@<SERVER_IP>
```

后续命令都在出现的服务器终端中执行，而不是在本机 PowerShell 中执行。

### 第 2 步：确认 Caddy 的运行方式

```bash
caddy version
sudo systemctl status caddy --no-pager
```

正常时会看到版本号，并在状态中看到：

```text
Active: active (running)
```

如果提示 `Unit caddy.service could not be found`，先停止本教程。服务器可能使用 Docker 或其他方式运行 Caddy，不能直接套用下面的 systemd 命令。

### 第 3 步：确认网页目录可以读取

```bash
ls -la /var/www/openlabstock
```

应当直接看到 `index.html`、`styles.css`、`script.js` 和 `assets`，不能在其中再套一层 `openlabstock-landing` 文件夹。

检查 Caddy 用户能否读取首页：

```bash
sudo -u caddy test -r /var/www/openlabstock/index.html && echo "Caddy 可以读取首页"
```

如果没有输出成功提示，修正读取权限：

```bash
sudo chmod -R a+rX /var/www/openlabstock
```

### 第 4 步：备份原有主配置

先创建带时间戳的备份：

```bash
backup="/etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)"
sudo cp /etc/caddy/Caddyfile "$backup"
echo "Caddyfile 已备份到：$backup"
```

`$backup` 是当前 SSH 会话中的变量。不要在验证成功前退出这个 SSH 会话，发生错误时可以直接用它恢复。

### 第 5 步：创建 OpenLabStock 独立配置

创建站点配置目录：

```bash
sudo mkdir -p /etc/caddy/sites
```

用 nano 打开新的站点配置：

```bash
sudo nano /etc/caddy/sites/openlabstock.caddy
```

将下面内容完整粘贴进去：

```caddyfile
openlabstock.com {
    root * /var/www/openlabstock

    encode zstd gzip
    file_server

    @html path / /index.html
    header @html Cache-Control "no-cache"

    header {
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
}

www.openlabstock.com {
    redir https://openlabstock.com{uri} permanent
}
```

nano 中的保存方法：

1. 按 `Ctrl+O`，底部出现文件名确认提示。
2. 直接按回车，确认保存到当前文件。
3. 按 `Ctrl+X`，退出 nano。

保存后重新打印文件，确认内容没有缺行：

```bash
sudo cat /etc/caddy/sites/openlabstock.caddy
```

配置含义：

- `openlabstock.com { ... }`：这个域名对应一个独立站点。
- `root`：网页文件所在目录。
- `encode`：启用压缩，减少传输体积。
- `file_server`：让 Caddy 提供静态文件。
- `@html` 和 `Cache-Control`：首页更新后让浏览器及时重新检查。
- `header`：增加基础浏览器安全响应头。
- `www.openlabstock.com`：把 `www` 永久跳转到不带 `www` 的主域名。

### 第 6 步：让主 Caddyfile 导入站点配置

先检查是否已经存在导入：

```bash
sudo grep -nF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile
```

如果命令打印出一行匹配结果，说明已经配置，不要重复添加。如果没有任何输出，打开主配置：

```bash
sudo nano /etc/caddy/Caddyfile
```

不要删除原有内容。在文件最末尾、所有现有网站配置块之外，另起一行添加：

```caddyfile
import /etc/caddy/sites/*.caddy
```

正确结构类似：

```caddyfile
existing-site.example.com {
    # 原有网站配置保持不变
}

import /etc/caddy/sites/*.caddy
```

不要把 `import` 写进某个 `example.com { ... }` 的大括号里面。完成后按 `Ctrl+O`、回车、`Ctrl+X` 保存退出。

再次确认导入存在且只有一次：

```bash
sudo grep -nF 'import /etc/caddy/sites/*.caddy' /etc/caddy/Caddyfile
```

### 第 7 步：格式化并验证配置

先格式化两个文件：

```bash
sudo caddy fmt --overwrite /etc/caddy/sites/openlabstock.caddy
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
```

`fmt` 只统一缩进和排版，不会启动配置。然后执行真正的语法检查：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

看到下面的结果才表示可以继续：

```text
Valid configuration
```

如果输出包含 `Error`、`parsing`、`unrecognized directive` 或具体行号，不要执行重载。根据错误行重新打开对应文件修正；拿不准时直接执行本文后面的回滚命令。

### 第 8 步：平滑加载新配置

验证成功后执行：

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

这里使用 `reload`，不会像停止再启动那样中断服务器上的其他网站。状态应继续显示：

```text
Active: active (running)
```

### 第 9 步：在服务器本机验证路由

```bash
curl -I -H "Host: openlabstock.com" http://127.0.0.1
```

正常情况下会看到类似：

```text
HTTP/1.1 308 Permanent Redirect
Location: https://openlabstock.com/
```

这表示 Caddy 已经识别 `openlabstock.com`，并把 HTTP 请求升级到 HTTPS。

### 第 10 步：验证公网 HTTPS

确认域名 DNS 已指向当前服务器，并且服务器的 TCP `80/443` 已开放，然后执行：

```bash
curl -I https://openlabstock.com
curl -I https://www.openlabstock.com
```

预期结果：

- `openlabstock.com` 返回 `200`。
- `www.openlabstock.com` 返回永久跳转，并指向 `https://openlabstock.com`。
- 第一次加载配置时，Caddy 会自动申请证书，可能需要等待数秒。

## 发布或更新网页

网页内容变化不需要重启或重载 Caddy，只需替换 `/var/www/openlabstock` 中的静态文件。

在本机 PowerShell 上传到服务器临时目录：

```powershell
ssh <SSH_USER>@<SERVER_IP> "mkdir -p /tmp/openlabstock-upload"
scp -r "C:\path\to\openlabstock-landing\*" <SSH_USER>@<SERVER_IP>:/tmp/openlabstock-upload/
```

登录服务器，将临时目录同步到专用网页目录：

```bash
ssh <SSH_USER>@<SERVER_IP>
sudo rsync -av --delete /tmp/openlabstock-upload/ /var/www/openlabstock/
sudo chmod -R a+rX /var/www/openlabstock
```

`--delete` 只允许用于已经确认的专用目录 `/var/www/openlabstock/`，不要改成其他服务器目录。

## 上线检查

先确认 Caddy 已识别站点：

```bash
curl -I -H "Host: openlabstock.com" http://127.0.0.1
```

正常情况下会返回 `308` 并跳转到 HTTPS。随后检查公网：

```bash
curl -I https://openlabstock.com
curl -I https://www.openlabstock.com
```

验收标准：

- `https://openlabstock.com` 返回 `200`。
- `https://www.openlabstock.com` 永久跳转到主域名。
- 首页图片、产品截图和二维码均能加载。
- 桌面端“全屏演示”可以进入、翻页和退出。
- 手机端没有横向滚动或文字覆盖。

## 排错与回滚

查看最近的 Caddy 日志：

```bash
sudo journalctl -u caddy -n 100 --no-pager
```

检查端口占用：

```bash
sudo ss -lntp | grep -E ':80|:443'
```

HTTPS 申请失败时依次检查：

1. 域名是否已经解析到当前服务器。
2. 防火墙或安全组是否开放 `80/443`。
3. 是否存在指向错误服务器的 `AAAA` 记录。
4. 是否有其他程序占用 `80/443`。
5. Caddy 日志中是否有证书申请或文件权限错误。

恢复前面生成的 Caddyfile 备份：

```bash
sudo cp "$backup" /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

如果已经退出了创建备份时的 SSH 会话，先用 `ls -lt /etc/caddy/Caddyfile.bak.*` 找到需要恢复的确切文件名，再执行恢复。
