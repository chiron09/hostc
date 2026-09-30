# 安装与使用（自托管版）

本仓库是 [akazwz/hostc](https://github.com/akazwz/hostc) 的自托管分支，在其之上增加了：

- **固定子域名**：账号绑定一个专属子域，隧道 URL 永久不变（重启、换设备都不变）
- **账号体系**：注册即得一个 API token，无需邮箱
- **管理面板**：`/admin` 页面查看隧道、强制下线
- **域名优选**：DNS-only CNAME + Worker 路由，国内访问更快

服务端已部署在本项目的 Cloudflare 账号上，**普通使用者只需要下面的「客户端安装」一节**。
自建服务端请看「服务端部署」。

---

## 一、客户端安装（其他设备如何用）

### 前提

只需要 **Node.js 22 或更高版本**。检查：

```sh
node -v      # 需要 v22.0.0 或更高
```

不需要 `npm install`，不需要任何环境变量——服务器地址已内置在文件里。

### 1. 下载 CLI

我们提供一个**单文件、零依赖**的 CLI（`ws`、`uqr` 已打包进去）：

**Windows (PowerShell)**

```powershell
curl.exe -sSL -o hostc.mjs https://github.com/chiron09/hostc/releases/download/v2.0.4-selfhost/hostc.mjs
```

**Linux / macOS**

```sh
curl -sSL -o hostc.mjs https://github.com/chiron09/hostc/releases/download/v2.0.4-selfhost/hostc.mjs
chmod +x hostc.mjs
```

### 2. 使用固定子域

假设你的本地服务跑在 `3000` 端口：

```sh
node hostc.mjs 3000 --token <你的TOKEN> --subdomain <你的子域>
```

输出：

```text
  https://<你的子域>.yyun.eu.cc  → http://localhost:3000

  Anyone with this URL can reach your local server. Press Ctrl+C to stop.
```

这个 URL **每次都是同一个**，换设备、重启、断网重连都不会变。

### 3. 少打点字（可选）

把 token 存进环境变量，以后就不用带 `--token`：

```powershell
# Windows（永久生效，需重开终端）
setx HOSTC_TOKEN <你的TOKEN>
```

```sh
# Linux / macOS
echo 'export HOSTC_TOKEN=<你的TOKEN>' >> ~/.bashrc
```

之后只需：

```sh
node hostc.mjs 3000 --subdomain <你的子域>
```

### 4. 注册新子域

需要再加一个固定地址时：

```sh
node hostc.mjs register mysite
```

会返回一个**只显示一次**的 token，务必立刻保存：

```text
  https://mysite.yyun.eu.cc  → your fixed subdomain

  API token (save it now — it is shown only once):
  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 5. 不想用固定子域？

不带 token 就是匿名模式，随机 URL，每次重启都变，但**多台设备可以同时用**：

```sh
node hostc.mjs 3000
```

### 命令行参数

```text
hostc <target> [options]
hostc register <子域> [--server <url>]

Target:
  3000                     http://localhost:3000
  127.0.0.1:8080           http://127.0.0.1:8080
  https://localhost:5173   任意 http(s) 地址

Options:
  --server <url>     隧道服务器（环境变量 HOSTC_SERVER）
  --subdomain <名字>  固定子域（需配合 --token 或 HOSTC_TOKEN）
  --token <token>    账号 API token（环境变量 HOSTC_TOKEN）
  --qr               打印公网 URL 的二维码
  -h, --help         帮助
  -v, --version      版本
```

---

## 二、常见问题

### 提示 "Another hostc process took over this tunnel"

**同一个子域同时只能有一台设备连接**。后连上的会顶掉先连上的，被顶掉的进程会退出。

想两台设备同时用：

- 给另一台注册不同子域：`node hostc.mjs register mysite`
- 或者用匿名模式：`node hostc.mjs 3000`

### 隧道 URL 打不开 / TLS 报错

先确认本地服务确实在跑：

```sh
curl http://127.0.0.1:3000
```

如果本地正常，可能是**本机代理软件**（Clash / v2ray 等）的 DNS 缓存把域名解析成了假 IP（`198.18.x.x`）。
处理：清一下代理的 DNS 缓存，或重启代理内核。

### 请求能到但很慢

当前域名使用 DNS-only CNAME 优选。若线路变化导致变慢，可换一个优选 CNAME 目标。

### 只能暴露 https 的本地服务吗？

不需要。本地是 http 也完全支持，隧道对外始终是 https。

---

## 三、服务端部署（自建）

如果你想把服务端部署到自己的 Cloudflare 账号：

### 1. 准备

- 一个托管在 Cloudflare 的域名（下称 `TUNNEL_DOMAIN`，例如 `yyun.eu.cc`）
- Node.js 22+ 与 pnpm

### 2. 添加 DNS 记录

在 Cloudflare 的 DNS 面板给该域名添加两条记录（**必须开启代理，橙云**）：

| 类型 | 名称            | 内容        | 代理   |
| ---- | --------------- | ----------- | ------ |
| A    | `@`（域名本身） | `192.0.2.1` | 已代理 |
| A    | `*`（通配符）   | `192.0.2.1` | 已代理 |

> `192.0.2.1` 是 RFC 5737 的文档保留地址，用作占位符。
> 因为流量由 Worker 路由接管，这个「源站」永远不会被真正访问。

### 3. 设置密钥

```sh
pnpm install
pnpm -F @hostc/server exec wrangler secret put TOKEN_SECRET   # 至少 32 字节随机值
pnpm -F @hostc/server exec wrangler secret put ADMIN_TOKEN    # /admin 面板的登录密钥
```

生成随机值：

```sh
openssl rand -base64 48
```

### 4. 部署

```sh
cd apps/server
pnpm exec wrangler deploy \
  --route "yyun.eu.cc/api/*" --zone "yyun.eu.cc" \
  --route "yyun.eu.cc/*"     --zone "yyun.eu.cc" \
  --route "*.yyun.eu.cc/*"   --zone "yyun.eu.cc" \
  --x-route-zones --var "TUNNEL_DOMAIN:yyun.eu.cc"
```

> ⚠️ **注意**：`wrangler deploy --route` 会**替换该 Worker 的全部路由**。
> 如果你有多个域名，必须在同一条命令里带上全部路由，否则别处的路由会被删掉
> （表现为 `403 error 1014`）。

### 5. 构建并分发自托管 CLI

```sh
# 把服务器地址编译成默认值
HOSTC_STANDALONE_SERVER=https://yyun.eu.cc pnpm -F hostc build:standalone
```

产物是 `apps/cli/dist/hostc-standalone.mjs`：单文件、零依赖，可直接分发。

> Windows PowerShell 用 `$env:HOSTC_STANDALONE_SERVER="https://yyun.eu.cc"; pnpm -F hostc build:standalone`

### 6. 管理面板

浏览器打开 `https://<你的域名>/admin`，输入 `ADMIN_TOKEN` 即可：

- 查看在线隧道（状态、URL、连接时间）
- 强制下线某条隧道

管理 API（都需要 `Authorization: Bearer <ADMIN_TOKEN>`）：

| 方法     | 路径                                | 作用                          |
| -------- | ----------------------------------- | ----------------------------- |
| `GET`    | `/api/admin/tunnels`                | 列出活跃隧道                  |
| `POST`   | `/api/admin/tunnels/:id/kick`       | 强制下线该隧道                |
| `GET`    | `/api/admin/accounts`               | 列出账号（不返回 token 哈希） |
| `DELETE` | `/api/admin/accounts/:子域`         | 删除账号，保留子域占位        |
| `DELETE` | `/api/admin/accounts/:子域?free=1`  | 删除账号并释放子域            |
| `POST`   | `/api/admin/accounts/:子域/release` | 仅释放已删子域的占位          |

---

## 四、开发

```sh
pnpm install
pnpm dev          # 本地隧道服务 http://localhost:8787
pnpm check        # 格式 + lint + 类型 + 单测
pnpm test:e2e     # 端到端测试
pnpm -F hostc build             # 常规 CLI（依赖 ws/uqr，需 npm install）
pnpm -F hostc build:standalone  # 单文件 CLI（零依赖，可分发给其他设备）
```

架构与协议细节见 [`docs/protocol.md`](./docs/protocol.md)。

---

## 五、安全提示

- **隧道 URL 是公开的**：任何拿到 URL 的人都能访问你本地暴露的服务。只暴露你愿意公开的内容。
- **子域占位**：删除账号后子域名默认**不会**被释放（防止他人抢注你曾用过的名字）。
  如确实要释放，用 `?free=1` 或 `/release` 接口。
- **token 只显示一次**：服务端只保存加盐哈希，无法找回。丢失请重新注册子域。

---

## 上游项目

本项目基于 [akazwz/hostc](https://github.com/akazwz/hostc)（Apache-2.0）。
上游的公共实例是 `hostc.dev` / `*.hostc.app`，与本自托管部署互不影响。
