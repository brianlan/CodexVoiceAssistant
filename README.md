# Codex Voice Assistant

通过浏览器中的 GPT-Live 实时语音会话，把任务派发给容器内的 Codex app-server。浏览器和 Realtime API 之间使用 WebRTC；网关只负责鉴权、SDP 控制、Codex JSON-RPC、执行事件和审批请求。

当前实现固定验证于：

- `@openai/codex 0.146.0`
- `thread/realtime/start` + `version: "v3"`
- 默认 Realtime 模型 `gpt-live-1-boulder-alpha`
- Node.js 22、React 19、WebSocket 和 WebRTC

## 功能

- `https://机器IP:3000` 局域网访问
- 单用户密码登录、HttpOnly/Secure session cookie、登录限流
- 本地 CA 和带局域网 IP SAN 的 HTTPS 证书自动生成
- GPT-Live WebRTC 双向语音和实时转录
- Codex thread 创建、恢复和历史列表
- Codex 回复、命令输出、文件修改及 MCP 活动展示
- 命令、文件、额外权限和 `request_user_input` 交互
- 文字输入降级：语音连接时发给 Live，否则直接发起 Codex turn
- `read-only`、`workspace-write`、`full-access`、`yolo` 四种权限模式
- Docker Compose 一键启动，app-server 不直接暴露给浏览器

## 架构

```text
Browser :3000 (HTTPS)
  ├─ WSS 控制/事件 ──> Voice Gateway
  └─ WebRTC 音频 ───> GPT-Live Realtime session
                              │ delegation.*
                              v
Voice Gateway ── JSON-RPC ──> Codex app-server
                              └─ /workspace、shell、文件、测试、MCP
```

浏览器不会收到 OpenAI/ChatGPT 凭据或 app-server capability token。

## 使用前提

- Docker Engine 和 Docker Compose v2；使用回环代理覆盖方案时宿主机必须是 Linux。
- 宿主机 Codex 已通过 ChatGPT 或 API Key 登录，并且 `.env` 中的 `HOST_CODEX_HOME` 指向其绝对路径，例如 `/home/alice/.codex`，不要写 `~/.codex`。
- 如需在容器内使用 `gh`，请先在宿主机执行 `gh auth login`；Compose 会把 `HOST_GH_CONFIG` 指向的目录以只读方式挂载到容器的 `/home/node/.config/gh`。镜像默认安装并固定 `gh 2.86.0`。
- `HOST_WORKSPACE` 是唯一挂载给 Codex 的工作目录；默认在容器内对应 `/workspace`。
- 访问设备具有麦克风权限，已信任本应用生成的 CA，并且能建立到 OpenAI Realtime 服务的 WebRTC 连接。
- 局域网防火墙允许访问宿主机 TCP 3000 端口。

## 快速启动

先在宿主机安装 Docker，并确保 Codex 已登录：

```bash
codex login status
```

生成 `.env`、随机密码和 app-server token：

```bash
./scripts/setup.sh
```

如果 `.env` 已存在，脚本会保留现有文件并退出，不会覆盖密码或其他手工配置。

脚本默认把当前目录作为 Codex workspace。启动前请检查 `.env`：

```dotenv
APP_HOST_IP=192.168.1.10
HOST_WORKSPACE=/absolute/path/to/project
HOST_CODEX_HOME=/home/you/.codex
HOST_GH_CONFIG=/home/you/.config/gh
CODEX_PERMISSION_MODE=workspace-write
# 可选
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=xhigh
```

然后启动：

```bash
docker compose up --build -d
docker compose ps
docker compose exec codex-app-server codex login status
docker compose exec codex-app-server gh auth status
docker compose exec codex-app-server git ls-remote origin HEAD
```

Codex 检查应显示 `Logged in using ChatGPT` 或已使用 API Key 登录；`gh` 检查应显示宿主机的 GitHub 账号；`git ls-remote` 应返回远端 HEAD。容器启动时会运行 `gh auth setup-git`，并通过仅存在于容器内的全局 Git 配置把 `git@github.com:` 和 `ssh://git@github.com/` remote 透明改写为认证后的 HTTPS，不会修改宿主机仓库的 `origin`。如果你的代理只监听宿主机 `127.0.0.1`，不要使用上面的普通启动命令，直接使用[回环代理模式](#仅监听-127001-的代理)。

访问：

```text
https://APP_HOST_IP:3000
```

登录密码位于 `.env` 的 `APP_PASSWORD`。`.env` 已被 Git 忽略，`setup.sh` 会用 `0600` 风格权限创建它。

## 信任局域网 CA

浏览器只允许 HTTPS 安全上下文访问麦克风。第一次启动时网关会生成：

```text
data/certs/ca.crt       # 要导入访问设备的根证书
data/certs/server.crt   # 自动签发的服务器证书
```

可在登录页点击“下载 CA 证书”，也可以直接把 `data/certs/ca.crt` 复制到访问设备，然后导入到“受信任的根证书颁发机构”。

- Linux：导入系统或浏览器证书库；Debian/Ubuntu 可复制为 `/usr/local/share/ca-certificates/codex-voice-ca.crt` 后运行 `sudo update-ca-certificates`。
- macOS：用“钥匙串访问”导入到“系统”，并设为始终信任。
- Windows：导入到“受信任的根证书颁发机构”。
- iOS/Android：把 CA 证书传到设备并安装；iOS 还需在“证书信任设置”中启用完全信任。

信任后完全退出并重新打开浏览器，再访问页面。如果更换机器 IP，只需修改 `APP_HOST_IP` 并重建网关；服务器证书会重新签发，但 CA 不变：

```bash
docker compose up -d --force-recreate voice-assistant
```

不要删除 `data/certs/ca.key`，除非准备让所有访问设备重新信任一个新 CA。

## 权限模式

在 `.env` 设置 `CODEX_PERMISSION_MODE`：

| 值 | Codex sandbox | 审批策略 |
|---|---|---|
| `read-only` | `read-only` | `on-request` |
| `workspace-write` | `workspace-write` | `on-request` |
| `full-access` | `danger-full-access` | `on-request` |
| `yolo` | `danger-full-access` | `never` |

`yolo` 等价于容器内的 `--dangerously-bypass-approvals-and-sandbox` 语义。它仍受 Docker 挂载边界限制，但可以无审批修改整个 `/workspace` 和挂载的 `CODEX_HOME`。界面会持续显示红色警告。

修改权限模式后，新建 thread 才会使用新配置：

```bash
docker compose up -d --force-recreate voice-assistant
```

## Codex 登录和 API Key

默认把宿主机 `HOST_CODEX_HOME` 挂载到容器内相同的绝对路径，因此 Codex state DB 中记录的 rollout 路径在重启后仍然有效。推荐先在每台宿主机执行一次 `codex login`。宿主机显示已登录并不总能保证容器可读取凭据：Codex 可能把凭据存进操作系统 keyring，而容器只能直接复用挂载目录中的文件凭据。请以容器内的检查结果为准：

```bash
docker compose exec codex-app-server codex login status
```

如果宿主机已登录但容器未登录，请确保 Codex 使用 file credential store，并重新在宿主机登录；文件凭据通常位于 `HOST_CODEX_HOME/auth.json`：

```toml
# ~/.codex/config.toml
cli_auth_credentials_store = "file"
```

若要使用 API Key 而不是挂载登录态，可在 `.env` 配置项目专属变量：

```dotenv
CODEX_API_KEY=...
CODEX_API_ENDPOINT=
CODEX_API_BASE_URL=
```

这些变量在 Compose 内映射为 `OPENAI_*`，名称特意不同，避免宿主 shell 中其他 provider 的 `OPENAI_ENDPOINT` 被意外继承。

使用 ChatGPT 登录态时，`CODEX_API_KEY`、`CODEX_API_ENDPOINT` 和 `CODEX_API_BASE_URL` 都可以留空；同样不需要在项目 `.env` 中设置 `OPENAI_*`。

## 代理网络

如果容器可以直接访问互联网，不需要配置代理。

如果代理能被 Docker bridge 访问：

```dotenv
CODEX_HTTP_PROXY=http://host.docker.internal:7890
CODEX_HTTPS_PROXY=http://host.docker.internal:7890
```

这里的地址必须能从容器网络访问。若代理实际只绑定宿主机 `127.0.0.1`，`host.docker.internal` 通常无法连接，请使用下一节的 host-network 覆盖方案。

### 仅监听 127.0.0.1 的代理

如果 Linux 宿主机平时这样启动 Codex：

```bash
http_proxy=http://127.0.0.1:18080 \
https_proxy=http://127.0.0.1:18080 \
codex
```

在 `.env` 设置：

```dotenv
CODEX_LOOPBACK_PROXY=http://127.0.0.1:18080
```

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.host-network.yml \
  up --build -d
```

此模式下 app-server 仅监听宿主机 `127.0.0.1:4222`，网关仍监听 `:3000`。它主要面向 Linux；Docker Desktop 环境优先使用默认 bridge 方案。

覆盖文件同时注入大小写两套 `HTTP_PROXY`/`HTTPS_PROXY`，并让 app-server 共享宿主机网络，因此容器内的 `127.0.0.1:18080` 就是宿主机代理。普通 `docker compose up` 不具备这个语义。

若希望后续命令更短，可在当前 shell 设置：

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.host-network.yml
docker compose ps
docker compose logs -f
```

容器代理负责 app-server 的 OpenAI HTTP/WebSocket 流量。浏览器的实时音频媒体链路仍由访问设备直接通过 WebRTC 建立；远程手机或电脑若无法访问相关 ICE/UDP/TCP 网络，可能出现“WebRTC 连接超时”，这不能仅靠容器的 `HTTP_PROXY` 修复。

## Codex 模型与 Realtime 配置

可选 `.env` 项：

```dotenv
REALTIME_MODEL=gpt-live-1-boulder-alpha
REALTIME_VOICE=
REALTIME_PROMPT=
CODEX_MODEL=
CODEX_REASONING_EFFORT=
```

`CODEX_REASONING_EFFORT` 可设为 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `ultra`，并作为 app-server 的 `config.model_reasoning_effort` 线程覆盖传递；具体可用级别仍取决于所选 Codex 模型。留空时使用模型或 Codex 配置的默认值。

例如：

```dotenv
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=xhigh
```

`CODEX_MODEL` 和 `CODEX_REASONING_EFFORT` 控制后端执行任务的 Codex 模型；`REALTIME_MODEL`、`REALTIME_VOICE` 和 `REALTIME_PROMPT` 控制前端语音会话。两者是相互独立的配置。修改后应重建或重建网关容器，并新建或恢复 thread 以应用线程覆盖。

空的 voice/model/prompt/effort 会被当作未设置，而不会作为空字符串发送给 app-server。WebRTC 请求固定使用：

```json
{
  "version": "v3",
  "outputModality": "audio",
  "includeStartupContext": true,
  "clientManagedHandoffs": false,
  "delegationAckFiller": false,
  "codexResponseHandoffMode": "bemTags"
}
```

## `.env` 配置速查

| 变量 | 默认值/要求 | 作用 |
|---|---|---|
| `APP_HOST_IP` | 必填 | 局域网 IP，也用于 HTTPS 证书 SAN |
| `APP_PORT` | `3000` | 默认 bridge 模式下映射到宿主机的端口 |
| `APP_PASSWORD` | 至少 12 字符 | Web 单用户登录密码 |
| `APP_SERVER_TOKEN` | 至少 24 字符 | 网关访问 app-server 的内部 capability token |
| `SESSION_TTL_HOURS` | `12` | Web 登录 session 有效时长 |
| `HOST_WORKSPACE` | 必填绝对路径 | 唯一挂载到 `/workspace` 的项目目录 |
| `HOST_CODEX_HOME` | 必填绝对路径 | 复用 Codex 登录、配置、threads 和 skills |
| `HOST_UID` / `HOST_GID` | 当前用户 | 让 app-server 以宿主机用户身份写挂载目录 |
| `CODEX_PERMISSION_MODE` | `workspace-write` | Codex sandbox 与审批策略 |
| `CODEX_VERSION` | `0.146.0` | 构建 app-server 镜像时安装的 Codex 版本 |
| `GH_VERSION` | `2.86.0` | 构建 app-server 镜像时安装的 GitHub CLI 版本 |
| `CODEX_MODEL` | Codex 默认值 | 后端任务模型覆盖 |
| `CODEX_REASONING_EFFORT` | 模型默认值 | 后端任务推理强度覆盖 |
| `REALTIME_MODEL` | `gpt-live-1-boulder-alpha` | GPT-Live 实时语音模型 |
| `REALTIME_VOICE` / `REALTIME_PROMPT` | 自动/未设置 | 可选声音与额外语音提示词 |
| `CODEX_API_*` | 空 | 可选 API Key 或自定义 OpenAI endpoint |
| `CODEX_HTTP_PROXY` / `CODEX_HTTPS_PROXY` | 空 | Docker bridge 可访问的代理 |
| `CODEX_LOOPBACK_PROXY` | 空 | host-network 模式下的宿主机回环代理 |

`.env` 包含密码和 token，已在 `.gitignore` 中排除，不要复制到版本控制或公开日志中。

## 运维命令

```bash
# 状态和日志
docker compose ps
docker compose logs -f --tail=200

# 更新代码后重建
docker compose up --build -d

# 停止并保留镜像、证书和 Codex 数据
docker compose down
```

若使用 host-network override，后续运维命令也需要同时带上两个 `-f` 参数。

## 常见问题

### 页面能打开，但浏览器无法使用麦克风

确认访问地址是 `https://`，导入并完全信任 `data/certs/ca.crt`，然后彻底退出并重启浏览器。仅绕过证书警告不一定会让页面成为可访问麦克风的 secure context。

### 宿主机 Codex 已登录，但容器提示未登录

检查 `HOST_CODEX_HOME` 是否为正确的绝对路径，并运行：

```bash
docker compose exec codex-app-server codex login status
```

若仍未登录，按上文将 `cli_auth_credentials_store` 调整为 `file` 后在宿主机重新登录。

### Codex 无法连接 OpenAI

如果代理只监听 `127.0.0.1`，确认使用了 `docker-compose.host-network.yml`，并检查容器实际代理变量：

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.host-network.yml \
  exec codex-app-server sh -lc 'env | grep -iE "^(http|https)_proxy="'
```

### 语音连接超时，但文字任务可用

这通常说明 app-server 通信正常，而访问设备到 OpenAI 的 WebRTC/ICE 媒体网络受限。检查访问设备的网络、系统代理、防火墙以及 UDP/TCP 出站策略。

### 修改 `.env` 后配置没有变化

环境变量只在容器创建时读取。重建网关，然后新建或恢复 thread：

```bash
docker compose up -d --force-recreate voice-assistant
```

## 开发与验证

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
```

测试覆盖：

- permission/YOLO 映射和空环境变量正规化
- session cookie 与密码验证
- app-server Bearer 鉴权、initialize 和服务端 JSON-RPC 请求
- Playwright HTTPS 登录、thread、Codex 执行流和浏览器 WebRTC offer

## 安全边界

- 不要把 app-server 的 4222 端口直接暴露到公网。
- `APP_PASSWORD` 和 `APP_SERVER_TOKEN` 必须保持随机且不要提交 Git。
- 这是单用户网关，不是多租户执行平台。
- Docker 只挂载一个 `HOST_WORKSPACE`，但 `full-access`/`yolo` 能修改该挂载内所有内容。
- `thread/realtime/*` 和 V3 Frameless Bidi 当前仍属于 Codex experimental API；升级 Codex 版本前应重新运行全部测试。

详细协议调研见 [Codex-app-server-thread-realtime-start-语音前端接入.md](./Codex-app-server-thread-realtime-start-语音前端接入.md)。
