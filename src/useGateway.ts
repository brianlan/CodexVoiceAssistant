import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayMessage } from "./types";

type PendingAction = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
};

export function useGateway(
  enabled: boolean,
  onMessage: (message: GatewayMessage) => void,
) {
  const [status, setStatus] = useState<"offline" | "connecting" | "ready">("offline");
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const handlerRef = useRef(onMessage);
  const pendingRef = useRef(new Map<string, PendingAction>());
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        attempts = 0;
      };
      socket.onmessage = (event) => {
        let message: GatewayMessage;
        try {
          message = JSON.parse(event.data) as GatewayMessage;
        } catch {
          return;
        }
        if (message.type === "ready") setStatus("ready");
        if (message.type === "actionResult" || message.type === "actionError") {
          const pending = message.actionId ? pendingRef.current.get(message.actionId) : undefined;
          if (pending) {
            window.clearTimeout(pending.timeout);
            pendingRef.current.delete(message.actionId!);
            if (message.type === "actionResult") pending.resolve(message.result);
            else pending.reject(new Error(message.message));
          }
        }
        handlerRef.current(message);
      };
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = undefined;
        setStatus("offline");
        if (event.code === 1008 || event.code === 1006) {
          handlerRef.current({ type: "status", appServerConnected: false, reason: "连接已断开" });
        }
        if (!disposed) {
          const delay = Math.min(10_000, 750 * 2 ** attempts++);
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close(1000, "page closed");
      for (const pending of pendingRef.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error("连接已关闭"));
      }
      pendingRef.current.clear();
    };
  }, [enabled]);

  const sendAction = useCallback(<T,>(action: Record<string, unknown>, timeoutMs = 45_000): Promise<T> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || status !== "ready") {
      return Promise.reject(new Error("Codex app-server 尚未连接"));
    }
    const actionId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(actionId);
        reject(new Error("操作超时"));
      }, timeoutMs);
      pendingRef.current.set(actionId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      socket.send(JSON.stringify({ ...action, actionId }));
    });
  }, [status]);

  return { status, sendAction };
}
