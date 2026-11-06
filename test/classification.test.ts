import { describe, expect, test } from "bun:test";

import { classifyThrown } from "../src/errors.js";

/**
 * Classification is structural only: no free-text scanning of messages that the
 * SDK or a remote server can influence (spec §7.5, §8). Each case below pins a
 * distinct signal, and asserts the adapter message never repeats the input text.
 */

const SECRET = "SECRET-TOKEN-9f2a";

function axiosLike(overrides: Record<string, unknown> = {}): Error & Record<string, unknown> {
  const error = new Error(`Request failed with status code 500: ${SECRET}`) as Error &
    Record<string, unknown>;
  error.isAxiosError = true;
  error.response = { status: 500, data: SECRET };
  return Object.assign(error, overrides);
}

function mcpError(code: number | string, message: string): Error & Record<string, unknown> {
  const error = new Error(message) as Error & Record<string, unknown>;
  error.name = "McpError";
  error.code = code;
  return error;
}

describe("classifyThrown", () => {
  test("an Axios transport failure is TRANSPORT_ERROR and never repeats server text", () => {
    const body = classifyThrown(axiosLike(), "demo.echo");
    expect(body.code).toBe("TRANSPORT_ERROR");
    expect(body.tool).toBe("demo.echo");
    expect(body.message).not.toContain(SECRET);
    expect(body.message).toContain("did not retry");
  });

  test("a socket code is TRANSPORT_ERROR", () => {
    const error = Object.assign(new Error(SECRET), { code: "ECONNRESET" });
    const body = classifyThrown(error, "demo.echo");
    expect(body.code).toBe("TRANSPORT_ERROR");
    expect(body.message).not.toContain(SECRET);
  });

  test("an MCP JSON-RPC request timeout is TIMEOUT", () => {
    const body = classifyThrown(mcpError(-32001, "Request timed out"), "demo.echo");
    expect(body.code).toBe("TIMEOUT");
  });

  test("an MCP server-side error is TRANSPORT_ERROR with a server-rejection message", () => {
    const body = classifyThrown(
      mcpError(-32603, `Tool 'echo' failed on the server: ${SECRET}`),
      "demo.mcp.echo",
    );
    expect(body.code).toBe("TRANSPORT_ERROR");
    expect(body.message).not.toContain(SECRET);
    expect(body.message).toContain("MCP server");
  });

  test("a session-level MCP failure without a JSON-RPC code is TRANSPORT_ERROR", () => {
    const body = classifyThrown(mcpError("ConnectionClosed", "Connection closed"), "demo.mcp.echo");
    expect(body.code).toBe("TRANSPORT_ERROR");
    expect(body.message).toContain("transport");
  });

  test("an SDK protocol-mismatch message is a CONFIGURATION_ERROR", () => {
    const body = classifyThrown(
      new Error(
        "Tool 'demo.echo' uses communication protocol 'http' which is not allowed by manual 'demo'. Allowed protocols: [\"sse\"]",
      ),
      "demo.echo",
    );
    expect(body.code).toBe("CONFIGURATION_ERROR");
    expect(body.message).toContain("configuration");
  });

  test("an SDK variable-substitution failure is a CONFIGURATION_ERROR", () => {
    const body = classifyThrown(
      new Error(`Invalid call template after variable substitution: ${SECRET}`),
      "demo.echo",
    );
    expect(body.code).toBe("CONFIGURATION_ERROR");
    expect(body.message).not.toContain(SECRET);
  });

  test("a response body that merely contains a timeout word is not a TIMEOUT", () => {
    const body = classifyThrown(new Error(`upstream said: request timeout ${SECRET}`), "demo.echo");
    expect(body.code).not.toBe("TIMEOUT");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  test("an unrecognised error falls back to INTERNAL_ERROR", () => {
    const body = classifyThrown(new Error(SECRET), "demo.echo");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).not.toContain(SECRET);
  });

  test("the transport's URL policy refusal is a CONFIGURATION_ERROR and keeps the URL out", () => {
    const body = classifyThrown(
      new Error(
        `Security error: URL must use HTTPS or be a literal loopback address (localhost / 127.0.0.1 / ::1). Got: "${SECRET}".`,
      ),
      "demo.echo",
    );
    expect(body.code).toBe("CONFIGURATION_ERROR");
    expect(body.message).toContain("HTTPS");
    expect(body.message).toContain("loopback");
    expect(body.message).not.toContain(SECRET);
  });
});
