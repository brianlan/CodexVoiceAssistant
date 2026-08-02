import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

type SendAction = <T>(action: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

export function useRealtime(sendAction: SendAction) {
  const [state, setState] = useState<"idle" | "requesting" | "connecting" | "live" | "error">("idle");
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();
  const peerRef = useRef<RTCPeerConnection | undefined>(undefined);
  const dataChannelRef = useRef<RTCDataChannel | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const threadRef = useRef<string | undefined>(undefined);
  const analyserCleanupRef = useRef<(() => void) | undefined>(undefined);
  const connectionTimerRef = useRef<number | undefined>(undefined);

  const cleanup = useCallback(() => {
    analyserCleanupRef.current?.();
    analyserCleanupRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    peerRef.current?.close();
    peerRef.current = undefined;
    dataChannelRef.current = undefined;
    threadRef.current = undefined;
    if (connectionTimerRef.current) window.clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = undefined;
    setLevel(0);
    setMuted(false);
    setState("idle");
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async (threadId: string) => {
    cleanup();
    setState("requesting");
    setError(undefined);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const message = "浏览器未处于可信 HTTPS 环境，无法访问麦克风。请先信任本应用的本地 CA。";
      setError(message);
      setState("error");
      throw new Error(message);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      threadRef.current = threadId;
      startLevelMeter(stream, setLevel, analyserCleanupRef);

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const audio = new Audio();
      audio.autoplay = true;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") markConnected();
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          setError(`WebRTC ${peer.connectionState}`);
          setState("error");
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (["connected", "completed"].includes(peer.iceConnectionState)) markConnected();
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const dataChannel = peer.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onopen = markConnected;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (!peer.localDescription?.sdp) throw new Error("浏览器没有生成 SDP offer");
      setState("connecting");
      await sendAction({
        type: "startRealtime",
        threadId,
        sdp: peer.localDescription.sdp,
      }, 50_000);
      connectionTimerRef.current = window.setTimeout(() => {
        if (peer.connectionState !== "connected" && dataChannel.readyState !== "open") {
          void sendAction({ type: "stopRealtime", threadId }).finally(() => {
            cleanup();
            setError("WebRTC 连接超时，请检查代理、防火墙或 ICE 网络");
            setState("error");
          });
        }
      }, 30_000);

      function markConnected() {
        if (connectionTimerRef.current) window.clearTimeout(connectionTimerRef.current);
        connectionTimerRef.current = undefined;
        setState("live");
      }
    } catch (caught) {
      cleanup();
      const message = caught instanceof Error ? caught.message : "实时语音启动失败";
      setError(message);
      setState("error");
      throw caught;
    }
  }, [cleanup, sendAction]);

  const applyAnswer = useCallback(async (threadId: string, sdp: string) => {
    const peer = peerRef.current;
    if (!peer || threadRef.current !== threadId) return;
    await peer.setRemoteDescription({ type: "answer", sdp });
  }, []);

  const stop = useCallback(async () => {
    const threadId = threadRef.current;
    if (threadId) {
      await sendAction({ type: "stopRealtime", threadId }).catch(() => undefined);
    }
    cleanup();
  }, [cleanup, sendAction]);

  const remoteClosed = useCallback(() => cleanup(), [cleanup]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  return { state, muted, level, error, start, stop, remoteClosed, toggleMute, applyAnswer };
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, 3_000);
    function done() {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

function startLevelMeter(
  stream: MediaStream,
  update: (level: number) => void,
  cleanupRef: MutableRefObject<(() => void) | undefined>,
) {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let animation = 0;
  const sample = () => {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    update(Math.min(1, average / 80));
    animation = requestAnimationFrame(sample);
  };
  sample();
  cleanupRef.current = () => {
    cancelAnimationFrame(animation);
    source.disconnect();
    void context.close();
  };
}
