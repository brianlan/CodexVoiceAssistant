import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "codex_voice_session";

type Session = { expiresAt: number };

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly passwordHash: Buffer;

  constructor(
    password: string,
    private readonly ttlMs: number,
  ) {
    this.passwordHash = hash(password);
  }

  verifyPassword(candidate: string): boolean {
    return timingSafeEqual(this.passwordHash, hash(candidate));
  }

  create(response: ServerResponse): string {
    const now = Date.now();
    for (const [existingToken, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(existingToken);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { expiresAt: now + this.ttlMs });
    response.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    );
    return token;
  }

  destroy(request: IncomingMessage, response: ServerResponse): void {
    const token = this.readToken(request);
    if (token) this.sessions.delete(token);
    response.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    );
  }

  isAuthenticated(request: IncomingMessage): boolean {
    const token = this.readToken(request);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  private readToken(request: IncomingMessage): string | undefined {
    const cookie = request.headers.cookie ?? "";
    for (const part of cookie.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === COOKIE_NAME) return value.join("=");
    }
    return undefined;
  }
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

type Attempt = { count: number; resetAt: number };

export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempt>();

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) return true;
    return entry.count < 8;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return;
    }
    entry.count += 1;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}
