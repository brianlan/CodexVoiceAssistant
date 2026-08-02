import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityEntry,
  GatewayMessage,
  PendingRequest,
  PublicConfig,
  ThreadSummary,
  TranscriptEntry,
} from "./types";
import { useGateway } from "./useGateway";
import { useRealtime } from "./useRealtime";

type AuthState = "loading" | "login" | "authenticated";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [config, setConfig] = useState<PublicConfig>();
  const [incomingQueue, setIncomingQueue] = useState<GatewayMessage[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [currentThread, setCurrentThread] = useState<ThreadSummary>();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [composer, setComposer] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/session")
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as { config: PublicConfig };
        setConfig(body.config);
        setAuth("authenticated");
      })
      .catch(() => setAuth("login"));
  }, []);

  const onGatewayMessage = useCallback((message: GatewayMessage) => {
    setIncomingQueue((current) => [...current, message]);
  }, []);
  const { status: gatewayStatus, sendAction } = useGateway(auth === "authenticated", onGatewayMessage);
  const realtime = useRealtime(sendAction);

  const refreshThreads = useCallback(async () => {
    const result = await sendAction<unknown>({ type: "listThreads" });
    setThreads(extractThreads(result));
  }, [sendAction]);

  useEffect(() => {
    const incoming = incomingQueue[0];
    if (!incoming) return;
    setIncomingQueue((current) => current.slice(1));
    if (incoming.type === "ready") {
      setConfig(incoming.config);
      setNotice(undefined);
      void refreshThreads().catch((error) => setNotice(messageOf(error)));
      return;
    }
    if (incoming.type === "fatal" || incoming.type === "error") {
      setNotice(incoming.message);
      return;
    }
    if (incoming.type === "status" && !incoming.appServerConnected) {
      setNotice(incoming.reason ?? "Codex app-server 已断开");
      return;
    }
    if (incoming.type === "serverRequest") {
      setPendingRequests((current) => current.some((item) => item.requestId === incoming.requestId)
        ? current
        : [...current, incoming]);
      return;
    }
    if (incoming.type !== "notification") return;
    const params = incoming.params ?? {};
    const threadId = stringValue(params.threadId);
    if (threadId && currentThread && threadId !== currentThread.id) return;

    switch (incoming.method) {
      case "thread/realtime/sdp":
        if (threadId && typeof params.sdp === "string") {
          void realtime.applyAnswer(threadId, params.sdp).catch((error) => setNotice(messageOf(error)));
        }
        break;
      case "thread/realtime/transcript/delta": {
        const role = stringValue(params.role) || "assistant";
        const delta = stringValue(params.delta);
        setLiveTranscript((current) => ({ ...current, [role]: (current[role] ?? "") + delta }));
        break;
      }
      case "thread/realtime/transcript/done": {
        const role = stringValue(params.role) || "assistant";
        const text = stringValue(params.text) || liveTranscript[role];
        if (text) appendTranscript(setTranscript, role === "user" ? "user" : "live", text);
        setLiveTranscript((current) => ({ ...current, [role]: "" }));
        break;
      }
      case "item/agentMessage/delta": {
        const delta = stringValue(params.delta);
        if (delta) appendStreamingCodex(setTranscript, delta);
        break;
      }
      case "turn/started": {
        const turn = asRecord(params.turn);
        setActiveTurnId(stringValue(turn?.id));
        addActivity(setActivity, {
          kind: "turn", title: "Codex 开始执行", status: "running",
          id: stringValue(turn?.id) || crypto.randomUUID(),
        });
        break;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const turnId = stringValue(turn?.id) || activeTurnId;
        setActiveTurnId(undefined);
        if (turnId) finishActivity(setActivity, turnId, stringValue(turn?.status) === "failed" ? "failed" : "done");
        void refreshThreads().catch(() => undefined);
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        if (item) upsertItemActivity(setActivity, item, incoming.method === "item/completed");
        break;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (itemId && delta) appendActivityDetail(setActivity, itemId, delta);
        break;
      }
      case "serverRequest/resolved": {
        const requestId = params.requestId;
        setPendingRequests((current) => current.filter((item) => item.requestId !== requestId));
        break;
      }
      case "thread/realtime/error":
        setNotice(stringValue(params.message) || "实时语音发生错误");
        break;
      case "thread/realtime/closed":
        realtime.remoteClosed();
        break;
    }
  }, [incomingQueue]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, liveTranscript]);

  const createThread = useCallback(async () => {
    const result = await sendAction<unknown>({ type: "createThread" });
    const thread = extractThread(result);
    if (!thread) throw new Error("app-server 没有返回 thread");
    setCurrentThread(thread);
    setTranscript([]);
    setActivity([]);
    localStorage.setItem("codexVoice.threadId", thread.id);
    setSidebarOpen(false);
    await refreshThreads();
    return thread;
  }, [refreshThreads, sendAction]);

  const resumeThread = useCallback(async (thread: ThreadSummary) => {
    if (realtime.state !== "idle") await realtime.stop();
    const result = await sendAction<unknown>({ type: "resumeThread", threadId: thread.id });
    const resumed = extractThread(result) ?? thread;
    setCurrentThread(resumed);
    setTranscript(historyFromThread(resumed));
    setActivity([]);
    localStorage.setItem("codexVoice.threadId", resumed.id);
    setSidebarOpen(false);
  }, [realtime, sendAction]);

  useEffect(() => {
    if (gatewayStatus !== "ready" || currentThread || threads.length === 0) return;
    const stored = localStorage.getItem("codexVoice.threadId");
    const match = threads.find((thread) => thread.id === stored);
    if (match) void resumeThread(match).catch(() => localStorage.removeItem("codexVoice.threadId"));
  }, [gatewayStatus, threads, currentThread, resumeThread]);

  const startVoice = useCallback(async () => {
    try {
      const thread = currentThread ?? await createThread();
      await realtime.start(thread.id);
    } catch (error) {
      setNotice(messageOf(error));
    }
  }, [createThread, currentThread, realtime]);

  const submitText = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    try {
      const thread = currentThread ?? await createThread();
      appendTranscript(setTranscript, "user", text);
      await sendAction({
        type: "sendText",
        threadId: thread.id,
        text,
        throughRealtime: realtime.state === "live" || realtime.state === "connecting",
      });
    } catch (error) {
      setNotice(messageOf(error));
    }
  }, [composer, createThread, currentThread, realtime.state, sendAction]);

  const resolveRequest = useCallback(async (
    request: PendingRequest,
    resolution: string,
    answers?: Record<string, string[]>,
  ) => {
    await sendAction({ type: "resolveRequest", requestId: request.requestId, resolution, answers });
    setPendingRequests((current) => current.filter((item) => item.requestId !== request.requestId));
  }, [sendAction]);

  const logout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.reload();
  }, []);

  if (auth === "loading") return <Splash />;
  if (auth === "login") {
    return <Login onSuccess={(nextConfig) => {
      setConfig(nextConfig);
      setAuth("authenticated");
    }} />;
  }

  const isVoiceActive = realtime.state !== "idle" && realtime.state !== "error";
  const connectionLabel = gatewayStatus === "ready" ? "App-server 已连接" : gatewayStatus === "connecting" ? "正在连接" : "连接中断";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div><strong>Codex Voice</strong><small>Realtime workspace</small></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏">×</button>
        </div>
        <button className="new-thread" onClick={() => void createThread().catch((error) => setNotice(messageOf(error)))} disabled={gatewayStatus !== "ready"}>
          <span>＋</span> 新建语音任务
        </button>
        <div className="sidebar-label">最近会话</div>
        <nav className="thread-list" aria-label="最近会话">
          {threads.length === 0 && <div className="empty-threads">还没有历史会话</div>}
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`thread-row ${currentThread?.id === thread.id ? "active" : ""}`}
              onClick={() => void resumeThread(thread).catch((error) => setNotice(messageOf(error)))}
            >
              <span className="thread-icon">⌁</span>
              <span><strong>{threadTitle(thread)}</strong><small>{formatThreadTime(thread)}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className={`permission-card ${config?.isYolo ? "danger" : ""}`}>
            <span className="permission-icon">{config?.isYolo ? "!" : "◇"}</span>
            <div><small>权限模式</small><strong>{permissionLabel(config?.permissionMode)}</strong></div>
          </div>
          <button className="logout" onClick={() => void logout()}>退出登录</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏">☰</button>
          <div className="workspace-title">
            <span className="eyebrow">ACTIVE WORKSPACE</span>
            <strong>{config?.workspace ?? "/workspace"}</strong>
          </div>
          <div className="top-status">
            <span className={`status-dot ${gatewayStatus}`} />
            <span>{connectionLabel}</span>
            <span className="divider" />
            <span className="model-name">{config?.realtimeModel}</span>
          </div>
        </header>

        {config?.isYolo && (
          <div className="yolo-banner"><strong>YOLO 模式</strong> 审批与 Codex 沙箱均已关闭；任务可直接修改挂载的 workspace。</div>
        )}
        {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice(undefined)}>×</button></div>}

        <div className="content-grid">
          <section className="conversation-panel">
            <div className="conversation-heading">
              <div><span className="eyebrow">CONVERSATION</span><h1>{currentThread ? threadTitle(currentThread) : "准备开始"}</h1></div>
              {activeTurnId && (
                <button className="stop-task" onClick={() => currentThread && void sendAction({ type: "interrupt", threadId: currentThread.id, turnId: activeTurnId })}>
                  停止任务
                </button>
              )}
            </div>
            <div className="conversation-feed" aria-live="polite">
              {transcript.length === 0 && !Object.values(liveTranscript).some(Boolean) ? (
                <EmptyConversation onStart={() => void startVoice()} disabled={gatewayStatus !== "ready"} />
              ) : (
                <>
                  {transcript.map((entry) => <MessageBubble key={entry.id} entry={entry} />)}
                  {Object.entries(liveTranscript).filter(([, text]) => text).map(([role, text]) => (
                    <MessageBubble key={`live-${role}`} entry={{
                      id: `live-${role}`, role: role === "user" ? "user" : "live", text, time: Date.now(),
                    }} streaming />
                  ))}
                </>
              )}
              <div ref={feedEndRef} />
            </div>

            <div className="voice-dock">
              <div className="voice-control">
                <button
                  className={`voice-orb ${isVoiceActive ? "active" : ""}`}
                  style={{ "--voice-level": realtime.level } as React.CSSProperties}
                  onClick={() => isVoiceActive ? void realtime.stop() : void startVoice()}
                  disabled={gatewayStatus !== "ready" || realtime.state === "requesting"}
                  aria-label={isVoiceActive ? "结束语音" : "开始语音"}
                >
                  <span className="orb-ring ring-one" /><span className="orb-ring ring-two" />
                  <span className="wave-bars">{[1,2,3,4,5].map((bar) => <i key={bar} />)}</span>
                </button>
                <div className="voice-copy">
                  <strong>{voiceTitle(realtime.state)}</strong>
                  <span>{realtime.error ?? (isVoiceActive ? "直接说出任务，Live 会把执行工作派发给 Codex" : "点击波形并允许浏览器使用麦克风")}</span>
                </div>
                {isVoiceActive && (
                  <button className={`mute-button ${realtime.muted ? "muted" : ""}`} onClick={realtime.toggleMute}>
                    {realtime.muted ? "取消静音" : "麦克风静音"}
                  </button>
                )}
              </div>
              <form className="composer" onSubmit={submitText}>
                <input
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  placeholder={isVoiceActive ? "也可以输入文字交给 Live…" : "输入任务，直接交给 Codex…"}
                  disabled={gatewayStatus !== "ready"}
                />
                <button type="submit" disabled={!composer.trim() || gatewayStatus !== "ready"} aria-label="发送">↑</button>
              </form>
            </div>
          </section>

          <aside className="activity-panel">
            <div className="panel-heading"><span className="eyebrow">CODEX ACTIVITY</span><span className={activeTurnId ? "working" : "quiet"}>{activeTurnId ? "执行中" : "空闲"}</span></div>
            <div className="activity-list">
              {activity.length === 0 ? (
                <div className="activity-empty"><div>⌘</div><strong>等待任务</strong><span>命令、文件修改和工具调用会显示在这里</span></div>
              ) : activity.slice(-20).map((item) => <ActivityCard key={item.id} entry={item} />)}
            </div>
            <div className="runtime-card">
              <div><span>Realtime</span><strong>{config?.realtimeModel}</strong></div>
              <div><span>Codex</span><strong>{config?.codexModel}</strong></div>
              <div><span>Reasoning</span><strong>{config?.codexReasoningEffort}</strong></div>
              <div><span>Voice</span><strong>{config?.realtimeVoice}</strong></div>
              <div><span>Transport</span><strong>WebRTC · V3</strong></div>
            </div>
          </aside>
        </div>
      </main>

      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}
      {pendingRequests[0] && (
        <RequestDialog
          request={pendingRequests[0]}
          onResolve={(resolution, answers) => void resolveRequest(pendingRequests[0], resolution, answers).catch((error) => setNotice(messageOf(error)))}
        />
      )}
    </div>
  );
}

function Login({ onSuccess }: { onSuccess: (config: PublicConfig) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await response.json() as { error?: string; config?: PublicConfig };
      if (!response.ok || !body.config) throw new Error(body.error ?? "登录失败");
      onSuccess(body.config);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-glow glow-one" /><div className="login-glow glow-two" />
      <section className="login-card">
        <div className="login-brand"><div className="brand-mark large"><span /></div><span>CODEX VOICE</span></div>
        <h1>说出来，<br />让 Codex 去完成。</h1>
        <p>低延迟 GPT-Live 对话界面，安全连接到这台机器上的 Codex app-server。</p>
        <form onSubmit={submit}>
          <label htmlFor="password">访问密码</label>
          <div className="password-field">
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus autoComplete="current-password" />
            <span>⌁</span>
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={busy || !password}>{busy ? "正在验证…" : "进入语音工作区"}</button>
        </form>
        <div className="certificate-help">
          <strong>麦克风不可用？</strong>
          <span>需要先让设备信任本应用的局域网 CA。</span>
          <a href="/api/ca.crt" download>下载 CA 证书</a>
        </div>
      </section>
      <footer>WebRTC 音频直接连接 Realtime session · 凭据不会发送到浏览器</footer>
    </main>
  );
}

function Splash() {
  return <div className="splash"><div className="brand-mark large"><span /></div><span>正在唤醒 Codex Voice</span></div>;
}

function EmptyConversation({ onStart, disabled }: { onStart: () => void; disabled: boolean }) {
  return (
    <div className="conversation-empty">
      <div className="empty-symbol">⌁</div>
      <span className="eyebrow">VOICE-DRIVEN CODEX</span>
      <h2>今天想完成什么？</h2>
      <p>实时语音模型负责理解和交流，Codex 在后台操作你的 workspace。</p>
      <button onClick={onStart} disabled={disabled}>开始语音会话 <span>→</span></button>
    </div>
  );
}

function MessageBubble({ entry, streaming = false }: { entry: TranscriptEntry; streaming?: boolean }) {
  return (
    <article className={`message ${entry.role}`}>
      <div className="message-meta"><strong>{roleLabel(entry.role)}</strong><span>{formatTime(entry.time)}</span></div>
      <div className="message-body">{entry.text}{streaming && <i className="typing-caret" />}</div>
    </article>
  );
}

function ActivityCard({ entry }: { entry: ActivityEntry }) {
  return (
    <article className={`activity-card ${entry.status}`}>
      <div className="activity-status"><i /><span>{activityKind(entry.kind)}</span><time>{formatTime(entry.time)}</time></div>
      <strong>{entry.title}</strong>
      {entry.detail && <pre>{entry.detail.slice(-3_000)}</pre>}
    </article>
  );
}

function RequestDialog({
  request,
  onResolve,
}: {
  request: PendingRequest;
  onResolve: (resolution: string, answers?: Record<string, string[]>) => void;
}) {
  const params = request.params ?? {};
  const isPermission = request.method === "item/permissions/requestApproval";
  const isQuestion = request.method.includes("requestUserInput");
  const isMcpElicitation = request.method === "mcpServer/elicitation/request";
  const questions = Array.isArray(params.questions) ? params.questions.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const command = displayValue(params.command) || displayValue(params.changes) || displayValue(params.permissions);

  if (isQuestion) {
    return (
      <div className="modal-backdrop">
        <section className="request-dialog">
          <span className="dialog-badge">CODEX 需要你的回答</span>
          {questions.map((question) => {
            const id = stringValue(question.id);
            const options = Array.isArray(question.options) ? question.options.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
            return <label className="question" key={id}>
              <strong>{stringValue(question.header)}</strong><span>{stringValue(question.question)}</span>
              {options.length > 0 ? (
                <select value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))}>
                  <option value="" disabled>请选择</option>
                  {options.map((option) => <option key={stringValue(option.label)} value={stringValue(option.label)}>{stringValue(option.label)}</option>)}
                </select>
              ) : (
                <input type={question.isSecret ? "password" : "text"} value={answers[id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [id]: event.target.value }))} />
              )}
            </label>;
          })}
          <div className="dialog-actions">
            <button className="secondary" onClick={() => onResolve("cancel")}>取消任务</button>
            <button onClick={() => onResolve("accept", Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, [value]])))} disabled={questions.some((question) => !answers[stringValue(question.id)])}>提交回答</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <section className="request-dialog approval-dialog">
        <div className="approval-symbol">!</div>
        <span className="dialog-badge">需要人工审批</span>
        <h2>{isMcpElicitation ? "MCP 服务请求输入" : isPermission ? "Codex 请求额外权限" : request.method.includes("fileChange") ? "允许修改文件？" : "允许运行这个操作？"}</h2>
        <p>{stringValue(params.reason) || "Codex 在继续执行前需要你的确认。"}</p>
        {command && <pre className="approval-command">{command}</pre>}
        <div className="dialog-actions stacked-mobile">
          <button className="secondary" onClick={() => onResolve(isPermission ? "deny" : "decline")}>拒绝</button>
          {!isPermission && !isMcpElicitation && <button className="secondary" onClick={() => onResolve("acceptForSession")}>本次会话允许</button>}
          {!isMcpElicitation && <button className="approve" onClick={() => onResolve(isPermission ? "grant" : "accept")}>仅本次允许</button>}
        </div>
      </section>
    </div>
  );
}

function extractThreads(result: unknown): ThreadSummary[] {
  const record = asRecord(result);
  const candidates = record?.data ?? record?.threads;
  return Array.isArray(candidates) ? candidates.map(asRecord).filter(Boolean) as ThreadSummary[] : [];
}

function extractThread(result: unknown): ThreadSummary | undefined {
  const record = asRecord(result);
  return asRecord(record?.thread) as ThreadSummary | undefined;
}

function historyFromThread(thread: ThreadSummary): TranscriptEntry[] {
  if (!Array.isArray(thread.turns)) return [];
  const entries: TranscriptEntry[] = [];
  for (const rawTurn of thread.turns) {
    const turn = asRecord(rawTurn);
    if (!turn || !Array.isArray(turn.items)) continue;
    for (const rawItem of turn.items) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const type = stringValue(item.type);
      if (type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
        const text = content.map((part) => stringValue(part.text)).filter(Boolean).join("\n");
        if (text) entries.push({ id: stringValue(item.id) || crypto.randomUUID(), role: "user", text, time: Date.now() });
      } else if (type === "agentMessage") {
        const text = stringValue(item.text);
        if (text) entries.push({ id: stringValue(item.id) || crypto.randomUUID(), role: "codex", text, time: Date.now() });
      }
    }
  }
  return entries;
}

function appendTranscript(setter: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>, role: TranscriptEntry["role"], text: string) {
  setter((current) => [...current, { id: crypto.randomUUID(), role, text, time: Date.now() }].slice(-200));
}

function appendStreamingCodex(setter: React.Dispatch<React.SetStateAction<TranscriptEntry[]>>, delta: string) {
  setter((current) => {
    const last = current.at(-1);
    if (last?.role === "codex" && Date.now() - last.time < 120_000) {
      return [...current.slice(0, -1), { ...last, text: last.text + delta }];
    }
    return [...current, { id: crypto.randomUUID(), role: "codex", text: delta, time: Date.now() }];
  });
}

function addActivity(setter: React.Dispatch<React.SetStateAction<ActivityEntry[]>>, entry: Omit<ActivityEntry, "time">) {
  setter((current) => [...current, { ...entry, time: Date.now() }].slice(-100));
}

function finishActivity(setter: React.Dispatch<React.SetStateAction<ActivityEntry[]>>, id: string, status: ActivityEntry["status"]) {
  setter((current) => current.map((entry) => entry.id === id ? { ...entry, status } : entry));
}

function upsertItemActivity(setter: React.Dispatch<React.SetStateAction<ActivityEntry[]>>, item: Record<string, unknown>, completed: boolean) {
  const id = stringValue(item.id) || crypto.randomUUID();
  const kind = stringValue(item.type) || "item";
  const title = itemTitle(item, kind);
  const detail = itemDetail(item);
  setter((current) => {
    const existing = current.findIndex((entry) => entry.id === id);
    const entry: ActivityEntry = {
      id, kind, title, detail,
      status: completed ? (stringValue(item.status) === "failed" ? "failed" : "done") : "running",
      time: existing >= 0 ? current[existing].time : Date.now(),
    };
    if (existing < 0) return [...current, entry].slice(-100);
    return current.map((candidate, index) => index === existing ? { ...candidate, ...entry, detail: detail || candidate.detail } : candidate);
  });
}

function appendActivityDetail(setter: React.Dispatch<React.SetStateAction<ActivityEntry[]>>, id: string, delta: string) {
  setter((current) => current.map((entry) => entry.id === id ? { ...entry, detail: (entry.detail ?? "") + delta } : entry));
}

function itemTitle(item: Record<string, unknown>, kind: string) {
  if (kind === "commandExecution") return displayValue(item.command) || "执行命令";
  if (kind === "fileChange") return "修改 workspace 文件";
  if (kind === "mcpToolCall") return `${stringValue(item.server)} · ${stringValue(item.tool)}`;
  if (kind === "agentMessage") return "生成回复";
  if (kind === "reasoning") return "分析任务";
  return kind;
}

function itemDetail(item: Record<string, unknown>) {
  return stringValue(item.aggregatedOutput) || stringValue(item.output) || displayValue(item.changes) || undefined;
}

function threadTitle(thread: ThreadSummary) {
  return thread.name || thread.preview?.trim().slice(0, 42) || "新的 Codex 会话";
}

function formatThreadTime(thread: ThreadSummary) {
  const seconds = thread.updatedAt ?? thread.createdAt;
  return seconds ? new Date(seconds * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : thread.id.slice(-8);
}

function voiceTitle(state: ReturnType<typeof useRealtime>["state"]) {
  if (state === "requesting") return "正在请求麦克风…";
  if (state === "connecting") return "正在连接 GPT-Live…";
  if (state === "live") return "正在聆听";
  if (state === "error") return "语音连接失败";
  return "点击开始实时语音";
}

function permissionLabel(mode?: string) {
  return ({ "read-only": "只读", "workspace-write": "Workspace Write", "full-access": "Full Access", yolo: "YOLO · 无沙箱" } as Record<string, string>)[mode ?? ""] ?? "未知";
}

function roleLabel(role: TranscriptEntry["role"]) {
  return ({ user: "你", live: "GPT-Live", codex: "Codex", system: "系统" } as const)[role];
}

function activityKind(kind: string) {
  return ({ commandExecution: "COMMAND", fileChange: "FILE CHANGE", mcpToolCall: "MCP TOOL", reasoning: "REASONING", agentMessage: "MESSAGE", turn: "TURN" } as Record<string, string>)[kind] ?? kind.toUpperCase();
}

function formatTime(time: number) {
  return new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误";
}
