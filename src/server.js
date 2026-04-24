import "dotenv/config";

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import pino from "pino";

import { config } from "./config.js";
import { SessionManager } from "./lib/session-manager.js";

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

const app = Fastify({
  loggerInstance: logger,
  bodyLimit: config.inputMaxBytes
});

const sessionManager = new SessionManager({
  logger,
  maxSessions: config.maxSessions,
  piPath: config.piPath,
  piArgs: config.piArgs,
  requestTimeoutMs: config.requestTimeoutMs,
  sessionTimeoutMs: config.sessionTimeoutMs,
  restartBackoffMs: config.restartBackoffMs
});

await app.register(rateLimit, {
  global: true,
  max: config.rateLimitMax,
  timeWindow: config.rateLimitWindow
});

await app.register(websocket);

app.addHook("onRequest", async (request, reply) => {
  if (!config.apiKey) {
    return;
  }

  const provided = request.headers["x-api-key"];
  if (provided !== config.apiKey) {
    reply.code(401);
    throw new Error("Unauthorized");
  }
});

app.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  request.log.error({ err: error }, "Request failed");
  reply.code(statusCode).send({
    status: "error",
    error: error.message || "Internal server error"
  });
});

app.get("/health", async () => ({
  status: "ok",
  sessions: sessionManager.listSessions()
}));

app.post("/session/create", async (request) => {
  const body = request.body || {};
  const sessionId = validateSessionId(body.session_id);
  const { created } = await sessionManager.createSession(sessionId);

  return {
    status: "ok",
    created,
    session_id: sessionId
  };
});

app.post("/session/delete", async (request) => {
  const body = request.body || {};
  const sessionId = validateSessionId(body.session_id);
  const deleted = await sessionManager.deleteSession(sessionId);

  return {
    status: "ok",
    deleted,
    session_id: sessionId
  };
});

app.post("/prompt", async (request) => {
  const body = request.body || {};
  const sessionId = validateSessionId(body.session_id);
  const message = validateMessage(body.message);

  const result = await sessionManager.prompt(sessionId, message);
  return {
    status: "ok",
    response: result.response,
    session_id: sessionId
  };
});

app.get("/stream", { websocket: true }, async (socket, request) => {
  const sessionId = validateSessionId(request.query?.session_id);
  sessionManager.attachWs(sessionId, socket);
  socket.send(JSON.stringify({
    status: "ok",
    session_id: sessionId,
    event: { type: "stream_attached" }
  }));
});

const signals = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  process.on(signal, async () => {
    logger.info({ signal }, "Shutdown requested");
    await app.close();
  });
}

app.addHook("onClose", async () => {
  await sessionManager.shutdown();
});

await app.listen({
  host: config.host,
  port: config.port
});

function validateSessionId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    const error = new Error("Invalid session_id");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
    const error = new Error("session_id contains invalid characters");
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function validateMessage(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    const error = new Error("Invalid message");
    error.statusCode = 400;
    throw error;
  }

  return value;
}
