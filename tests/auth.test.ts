import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../server/auth.js";

describe("single-user session authentication", () => {
  it("uses timing-safe password verification and secure cookies", () => {
    const store = new SessionStore("correct-horse-battery-staple", 60_000);
    expect(store.verifyPassword("correct-horse-battery-staple")).toBe(true);
    expect(store.verifyPassword("wrong-password")).toBe(false);

    let cookie = "";
    const response = {
      setHeader(_name: string, value: string) { cookie = value; },
    } as unknown as ServerResponse;
    store.create(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const request = { headers: { cookie: cookie.split(";")[0] } } as IncomingMessage;
    expect(store.isAuthenticated(request)).toBe(true);
  });
});
