/**
 * Who is calling: each terminal Tacit starts gets a credential of its own,
 * derived from a secret made at launch, so a call to Tacit's local API can say
 * which terminal it comes from and be believed. The launch token (in the port
 * file) only says the caller is on this Mac; anything that acts on a terminal's
 * behalf, such as driving the browser wired to it, needs this.
 *
 * Nothing is stored: the credential is worked out again to check it. A new
 * launch makes a new secret, and terminals started then get new credentials.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The environment variable a terminal's credential travels in. */
export const TERMINAL_TOKEN_ENV = "TACIT_TERMINAL_TOKEN";
/** The request headers the tool server sends them in. */
export const TERMINAL_ID_HEADER = "x-tacit-terminal";
export const TERMINAL_TOKEN_HEADER = "x-tacit-terminal-token";

const TERMINAL_ID = /^[A-Za-z0-9._-]{1,128}$/;

export class TerminalCredentials {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  tokenFor(terminalId: string): string {
    return createHmac("sha256", this.secret).update(`terminal:${terminalId}`).digest("base64url");
  }

  /** The terminal a request comes from, if it proved it; null otherwise. */
  verify(terminalId: unknown, token: unknown): string | null {
    if (typeof terminalId !== "string" || typeof token !== "string" || !TERMINAL_ID.test(terminalId)) return null;
    const expected = Buffer.from(this.tokenFor(terminalId));
    const supplied = Buffer.from(token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? terminalId : null;
  }
}

/** This launch's. */
export const terminalCredentials = new TerminalCredentials();
