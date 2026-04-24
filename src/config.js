const toInt = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const splitArgs = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: toInt(process.env.PORT, 3100),
  apiKey: process.env.API_KEY || "",
  piPath: process.env.PI_PATH || "pi",
  piArgs: splitArgs(process.env.PI_ARGS),
  maxSessions: toInt(process.env.MAX_SESSIONS, 10),
  sessionTimeoutMs: toInt(process.env.SESSION_TIMEOUT_MS, 15 * 60 * 1000),
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 60 * 1000),
  inputMaxBytes: toInt(process.env.INPUT_MAX_BYTES, 64 * 1024),
  rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 60),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW || "1 minute",
  restartBackoffMs: toInt(process.env.RESTART_BACKOFF_MS, 1000)
};
