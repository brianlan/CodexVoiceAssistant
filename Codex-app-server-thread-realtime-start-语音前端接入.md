---
tags:
  - Codex
  - app-server
  - realtime
  - GPT-Live
  - WebRTC
  - voice-agent
---

# Codex app-server `thread/realtime/start` 与 GPT-Live 语音前端接入

> 基于当前 Codex 仓库代码调研整理。
>
> 结论：当前 `app-server` 已经提供 `thread/realtime/start`，并实现了“实时语音前端 + Codex 后端执行 Agent”的内部链路。不过 realtime conversation、V3 Frameless Bidi 和部分 WebSocket/WebRTC 能力仍处于 experimental / under-development 状态。

## 一、总体结论

如果希望实现：

```text
GPT-Live 语音前端
        |
        | 语音对话、转录、实时回复
        v
Realtime Session
        |
        | delegation / handoff
        v
Codex Thread
        |
        | shell、文件修改、测试、MCP、代码执行
        v
Codex Agent Runtime
```

当前最值得采用的路径是：

```text
thread/realtime/start
version: "v3"
transport: { type: "webrtc", sdp: ... }
```

V3 使用 Frameless Bidi / delegation 协议，代码中的默认模型是：

```text
gpt-live-1-boulder-alpha
```

需要注意：如果 WebRTC 请求不显式设置 `version`，当前代码默认走 V1，而不是 V3。因此 GPT-Live 场景应显式指定：

```json
"version": "v3"
```

---

## 二、当前提供的 Realtime API

协议定义在：

```text
codex-rs/app-server-protocol/src/protocol/v2/realtime.rs
```

相关接口包括：

```text
thread/realtime/start
thread/realtime/appendAudio
thread/realtime/appendText
thread/realtime/appendSpeech
thread/realtime/stop
thread/realtime/listVoices
```

这些方法在协议中标记为 experimental。客户端初始化时需要声明：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

否则 app-server 会拒绝 realtime API 请求。

---

## 三、Realtime 支持的三个版本

| 版本 | 上游协议 | 主要用途 |
|---|---|---|
| `v1` | Legacy Bidi，使用 `conversation.handoff.*` | 老的 Codex Voice 路径 |
| `v2` | Realtime Voice API | 标准 Realtime Voice，包括 audio/text |
| `v3` | Frameless Bidi，使用 `delegation.*` | 当前 GPT-Live / Codex delegation 路径 |

代码中的对应关系大致是：

```rust
RealtimeWsVersion::V1 => RealtimeEventParser::V1,
RealtimeWsVersion::V2 => RealtimeEventParser::RealtimeV2,
RealtimeWsVersion::V3 => RealtimeEventParser::FramelessBidi,
```

V3 的默认 realtime 模型定义在：

```text
codex-rs/core/src/realtime_conversation.rs
```

---

## 四、WebRTC 接入方式

WebRTC 是浏览器语音前端较推荐的接入方式。

整体过程：

1. 浏览器创建 `RTCPeerConnection`。
2. 浏览器添加麦克风音频 track。
3. 浏览器创建 `oai-events` data channel。
4. 浏览器生成 SDP offer。
5. 通过 app-server JSON-RPC 调用 `thread/realtime/start`。
6. app-server 服务端创建 Realtime call。
7. app-server 通过 `thread/realtime/sdp` 返回 SDP answer。
8. 浏览器设置 remote description。
9. 浏览器与上游 Realtime session 直接传输音频。
10. app-server 通过 server-side sideband WebSocket 监听 delegation，并驱动 Codex。

### 浏览器创建 offer 的示例

```javascript
const pc = new RTCPeerConnection();

const audioElement = new Audio();
audioElement.autoplay = true;

pc.ontrack = (event) => {
  audioElement.srcObject = event.streams[0];
};

const mediaStream =
  await navigator.mediaDevices.getUserMedia({ audio: true });

pc.addTrack(mediaStream.getAudioTracks()[0], mediaStream);

// 当前代码要求创建这个 data channel
pc.createDataChannel("oai-events");

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

然后将：

```javascript
pc.localDescription.sdp
```

通过 app-server JSON-RPC 发送给 `thread/realtime/start`。

---

## 五、WebRTC 版 `thread/realtime/start` 请求

示例：

```json
{
  "id": 40,
  "method": "thread/realtime/start",
  "params": {
    "threadId": "thr_123",
    "version": "v3",
    "outputModality": "audio",
    "prompt": "You are a concise voice assistant that delegates all execution work to Codex.",
    "includeStartupContext": true,
    "clientManagedHandoffs": false,
    "delegationAckFiller": false,
    "transport": {
      "type": "webrtc",
      "sdp": "v=0\r\no=..."
    }
  }
}
```

JSON-RPC 请求会先返回一个空结果：

```json
{
  "id": 40,
  "result": {}
}
```

注意：SDP answer 不会放在这个 response 里，而是异步通过通知返回。

首先是：

```json
{
  "method": "thread/realtime/started",
  "params": {
    "threadId": "thr_123",
    "realtimeSessionId": "thr_123",
    "version": "v3"
  }
}
```

随后是：

```json
{
  "method": "thread/realtime/sdp",
  "params": {
    "threadId": "thr_123",
    "sdp": "v=0\r\no=..."
  }
}
```

浏览器收到后设置：

```javascript
await pc.setRemoteDescription({
  type: "answer",
  sdp: notification.params.sdp,
});
```

之后浏览器的音频通过 WebRTC 传输，不需要再调用 `thread/realtime/appendAudio`。

---

## 六、WebSocket 音频接入方式

如果不使用 WebRTC，可以让前端通过 app-server JSON-RPC 发送音频帧。

启动 realtime：

```json
{
  "method": "thread/realtime/start",
  "id": 40,
  "params": {
    "threadId": "thr_123",
    "version": "v2",
    "outputModality": "audio",
    "transport": {
      "type": "websocket"
    }
  }
}
```

也可以省略 `transport`，使用默认 WebSocket 路径。

发送音频：

```json
{
  "id": 41,
  "method": "thread/realtime/appendAudio",
  "params": {
    "threadId": "thr_123",
    "audio": {
      "data": "BASE64_PCM_DATA",
      "sampleRate": 24000,
      "numChannels": 1,
      "samplesPerChannel": 480
    }
  }
}
```

当前代码使用的音频配置主要是：

```text
audio/pcm
24,000 Hz
通常单声道
base64 编码
```

服务端输出音频通知示例：

```json
{
  "method": "thread/realtime/outputAudio/delta",
  "params": {
    "threadId": "thr_123",
    "audio": {
      "data": "BASE64_PCM_DATA",
      "sampleRate": 24000,
      "numChannels": 1,
      "samplesPerChannel": 512
    }
  }
}
```

相对于 WebRTC，WebSocket 模式会有：

- base64 编码开销
- 更多 JSON-RPC 消息
- 更高延迟
- 前端自行处理音频 buffer 的复杂度

因此，浏览器端实时语音通常优先考虑 WebRTC。

---

## 七、GPT-Live 如何触发 Codex 执行任务

V3 realtime session 会产生 delegation 事件，例如可以抽象为：

```json
{
  "type": "delegation.created",
  "item": {
    "id": "delegation_123",
    "type": "delegation",
    "target": "client",
    "content": [
      {
        "type": "input_text",
        "text": "请检查当前项目并运行测试"
      }
    ]
  }
}
```

app-server 的 sideband 会把这个事件解析为 realtime handoff/delegation，然后进入：

```text
codex-rs/core/src/realtime_conversation.rs
```

核心调用链是：

```text
Realtime delegation / handoff
  -> realtime_delegation_from_handoff
  -> sess.route_realtime_text_input(text)
  -> handlers::user_input_or_turn(...)
  -> Codex 正常 Agent turn
```

`route_realtime_text_input` 最终相当于向当前 thread 提交一个普通用户请求，语义接近：

```json
{
  "method": "turn/start",
  "params": {
    "threadId": "thr_123",
    "input": [
      {
        "type": "text",
        "text": "请检查当前项目并运行测试"
      }
    ]
  }
}
```

因此 realtime 语音并不是直接调用一个特殊的“语音版 shell API”，而是：

```text
语音对话
  -> GPT-Live 理解意图
  -> delegation
  -> Codex 普通 Agent turn
  -> Codex 执行 shell / 文件 / 测试 / MCP
```

---

## 八、Codex 结果如何返回给 GPT-Live

当 Codex turn 产生输出时，app-server 会通过 sideband 将结果写回 realtime session。

V3 使用类似：

```text
delegation.context.append
```

例如：

```json
{
  "type": "delegation.context.append",
  "delegation_item_id": "delegation_123",
  "content": [
    {
      "type": "input_text",
      "text": "测试已经完成，发现 2 个失败用例。"
    }
  ]
}
```

之后 GPT-Live 可以把结果继续转换成自然语言和语音。

这形成了双模型架构：

### GPT-Live

- 负责语音识别
- 负责自然对话
- 判断是否 delegation
- 负责把 Codex 结果说给用户听

### Codex

- 负责代码任务
- 负责 shell、文件、测试和 MCP
- 负责真实执行
- 负责产生执行结果

相关 prompt：

```text
codex-rs/prompts/templates/realtime/backend_prompt.md
```

其核心设计是：realtime model 作为 conversational surface，Codex backend 负责执行具体工作。

---

## 九、Codex 输出路由模式

`thread/realtime/start` 中有几个重要参数。

### 1. 默认自动 handoff

```json
{
  "clientManagedHandoffs": false
}
```

app-server 自动把 Codex 输出发送回 realtime session。

### 2. `codexResponseHandoffMode`

V3 支持：

```text
thinking
commentary
bemTags
```

#### `thinking`

默认模式。Codex 输出通过无 channel 的 delegation append 发送，适合让 live 模型自行理解。

#### `commentary`

Codex 输出都发送到 commentary channel。

#### `bemTags`

根据 Codex 输出中的 BEM 标签决定 channel：

```text
analysis    -> commentary
commentary  -> commentary
final       -> speakable
```

如果希望：

- Codex 的过程更新显示在 UI，但不直接朗读
- Codex 的最终结果由语音前端读出来

可以测试：

```json
{
  "codexResponseHandoffMode": "bemTags"
}
```

### 3. `codexResponsesAsItems`

```json
{
  "codexResponsesAsItems": true
}
```

让 Codex 输出以 realtime conversation item 的形式写入，而不是使用 delegation append。

### 4. `clientManagedHandoffs`

如果设置：

```json
{
  "clientManagedHandoffs": true
}
```

app-server 不会自动把 Codex 输出发送回 realtime session。应用自己决定什么时候、以什么形式回传：

```text
thread/realtime/appendSpeech
thread/realtime/appendText
```

例如：

```json
{
  "id": 51,
  "method": "thread/realtime/appendSpeech",
  "params": {
    "threadId": "thr_123",
    "text": "测试已经完成，结果是……"
  }
}
```

该模式适合需要自己控制以下策略的应用：

- 哪些 Codex 进度告诉用户
- 哪些结果应该朗读
- 哪些内容只显示在 UI
- 什么时候让 GPT-Live 继续回复

---

## 十、客户端需要监听的事件

### Realtime 事件

```text
thread/realtime/started
thread/realtime/sdp
thread/realtime/itemAdded
thread/realtime/transcript/delta
thread/realtime/transcript/done
thread/realtime/outputAudio/delta
thread/realtime/error
thread/realtime/closed
```

`thread/realtime/itemAdded` 可能携带 handoff/delegation 请求信息，例如：

```json
{
  "type": "handoff_request",
  "handoff_id": "...",
  "item_id": "...",
  "input_transcript": "...",
  "active_transcript": []
}
```

### Codex 普通 Agent 事件

由于 delegation 会真正启动 Codex turn，还应该监听：

```text
turn/started
turn/completed
item/started
item/completed
item/agentMessage/delta
item/commandExecution/outputDelta
item/fileChange/*
item/mcpToolCall/*
```

Realtime 事件是临时传输事件，不是 `ThreadItem`，不会直接出现在 `thread/read` 或 `thread/resume` 中。但 delegation 触发的 Codex turn 本身仍属于正常 Codex thread 生命周期。

---

## 十一、启用 realtime feature

realtime conversation 当前默认关闭。

配置文件：

```toml
[features]
realtime_conversation = true
```

或者使用启动参数：

```bash
codex --enable realtime_conversation app-server \
  --listen ws://127.0.0.1:4222
```

客户端初始化时还要发送：

```json
{
  "capabilities": {
    "experimentalApi": true
  }
}
```

如果 feature 没有开启，代码会返回类似：

```text
thread <id> does not support realtime conversation
```

相关测试：

```text
codex-rs/app-server/tests/suite/v2/realtime_conversation.rs
realtime_conversation_requires_feature_flag
```

---

## 十二、推荐的系统架构

### 推荐方案：WebRTC + V3 delegation

```text
Browser / GPT-Live UI
  |
  | 1. app-server JSON-RPC 控制连接
  |    initialize
  |    thread/start
  |    thread/realtime/start
  |
  | 2. SDP offer / answer
  |
  | 3. WebRTC 音频和 oai-events
  v
OpenAI GPT-Live / Frameless Bidi session
  ^
  |
  | server-side sideband WebSocket
  |
Codex app-server
  |
  | delegation.created -> route_realtime_text_input
  v
Codex Thread
  |
  | Responses API
  | shell / files / MCP / sandbox
  v
Codex execution
```

建议初始参数：

```json
{
  "threadId": "thr_123",
  "version": "v3",
  "outputModality": "audio",
  "clientManagedHandoffs": false,
  "delegationAckFiller": false,
  "codexResponseHandoffMode": "bemTags",
  "includeStartupContext": true,
  "transport": {
    "type": "webrtc",
    "sdp": "..."
  }
}
```

参数含义：

- `v3`：使用 GPT-Live / Frameless Bidi 路径
- `audio`：语音输出
- `clientManagedHandoffs:false`：先让 app-server 自动处理 Codex 结果
- `delegationAckFiller:false`：避免额外的 delegation filler 语音
- `bemTags`：尝试区分后台进度和最终可朗读结果
- `includeStartupContext:true`：将当前 Codex thread 的上下文带给 realtime session

---

## 十三、重要边界：不是通用 WebRTC 音频代理

当前 `thread/realtime/start` 的 WebRTC 不是一个通用的 WebRTC 音频转发服务。

实际关系是：

```text
浏览器 WebRTC
        <-> OpenAI Realtime / GPT-Live session
```

而不是：

```text
浏览器
        <-> 任意第三方 GPT-Live server
```

app-server 在中间通过 sideband 连接 realtime session，负责：

- 监听 delegation
- 启动 Codex turn
- 接收 Codex 输出
- 把 Codex 结果写回 live session

因此：

- 如果“GPT-Live 前端”指浏览器端使用这套 OpenAI Live/WebRTC 协议，可以采用当前路径。
- 如果 GPT-Live 是另一个独立的语音模型或第三方 WebRTC 服务，不能直接把它的 SDP 塞给当前 app-server。
- 如果只是“语音识别后控制 Codex”，更稳妥的方式是把识别结果通过 `turn/start` 发给 Codex，再将 Codex 输出交给 GPT-Live TTS。

简化路径：

```text
语音前端 ASR
   -> turn/start
   -> Codex 执行
   -> item/agentMessage/delta / turn/completed
   -> GPT-Live TTS
```

这条路径不依赖当前仍处于 under-development 的 delegation 协议。

---

## 十四、部署和安全建议

不要把原始 app-server WebSocket 直接暴露给公网，原因包括：

- app-server WebSocket transport 当前仍标注为 experimental / unsupported。
- realtime conversation 默认关闭且仍在 under development。
- app-server 本身不是完整的多租户 SaaS 网关。
- 需要自行处理用户认证、thread 路由、workspace 隔离、`CODEX_HOME` 隔离、配额和审计。

更合理的部署方式：

```text
Browser
  |
  | HTTPS / WSS
  v
Your Voice Gateway
  |
  | 用户认证、thread 路由、限流、审计
  | Unix socket 或内网 WebSocket
  v
Codex app-server
```

服务端应确保：

- 浏览器不接触上游 Realtime API 凭证。
- 每个用户或租户使用独立的 thread 和 workspace。
- 必要时使用独立 `CODEX_HOME`。
- 对 Codex 命令执行、文件修改和审批请求做隔离。
- 为长时间 realtime session 设置超时、并发和资源限制。
- 不直接把未经审计的 shell 执行能力暴露给普通用户。

---

## 十五、关键代码位置

```text
codex-rs/app-server/README.md
```

Realtime API、WebRTC 流程和客户端接入说明。

```text
codex-rs/app-server-protocol/src/protocol/v2/realtime.rs
```

`thread/realtime/*` 参数、响应和通知类型。

```text
codex-rs/app-server/src/request_processors/turn_processor.rs
```

app-server 如何将 JSON-RPC realtime 请求转成 Codex Core 操作。

```text
codex-rs/core/src/realtime_conversation.rs
```

Realtime session、WebRTC sideband、delegation、Codex 输出回传的核心实现。

```text
codex-rs/codex-api/src/endpoint/realtime_call.rs
```

WebRTC call 创建、SDP 交换和 sideband 连接。

```text
codex-rs/codex-api/src/endpoint/realtime_websocket/
```

V1、V2、V3 realtime wire protocol 适配。

```text
codex-rs/prompts/templates/realtime/backend_prompt.md
```

Realtime 前端模型如何将任务交给 Codex backend 的系统提示词。

```text
codex-rs/app-server/tests/suite/v2/realtime_conversation.rs
```

WebRTC、V3 delegation、Codex 输出回传的集成测试。

---

## 最终判断

当前 code base 不仅提供了 `thread/realtime/start`，而且已经实现了“GPT-Live 语音前端通过 delegation 驱动 Codex 执行任务”的完整内部链路。

推荐优先验证：

```text
WebRTC + version:v3 + delegation + bemTags
```

但生产使用前需要接受并处理以下事实：

1. realtime conversation 仍是 experimental / under-development。
2. V3 Frameless Bidi 仍不是稳定的通用公共协议。
3. app-server WebSocket transport 当前不适合直接公网暴露。
4. 多用户认证、租户隔离、workspace 隔离、资源限额和审计需要由外层 Gateway 自行补齐。
5. 如果只需要“语音控制 Codex”，ASR 文本转 `turn/start` 是更简单、更稳妥的替代方案。
