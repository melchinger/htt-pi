import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { attachJsonlReader } from "./jsonl-reader.js";

function extractTextFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant") {
    return "";
  }

  return extractTextFromContent(message.content);
}

export class PiProcess extends EventEmitter {
  constructor(options) {
    super();
    this.sessionId = options.sessionId;
    this.piPath = options.piPath;
    this.piArgs = options.piArgs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.restartBackoffMs = options.restartBackoffMs;
    this.logger = options.logger;

    this.child = null;
    this.currentRun = null;
    this.pendingResponses = new Map();
    this.isStopping = false;
    this.restartTimer = null;
    this.closed = false;
    this.recentStderr = [];
  }

  async start() {
    if (this.closed) {
      throw new Error("Process already closed");
    }

    if (this.child && !this.child.killed) {
      return;
    }

    const resolved = resolveSpawnCommand(this.piPath, ["--mode", "rpc", "--no-session", ...this.piArgs]);
    this.recentStderr = [];
    this.child = spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(resolved.spawnOptions || {})
    });

    this.logger.info(
      { sessionId: this.sessionId, command: resolved.command, args: resolved.args },
      "Started Pi process"
    );

    attachJsonlReader(this.child.stdout, (line) => this.#handleStdoutLine(line));
    attachJsonlReader(this.child.stderr, (line) => {
      this.recentStderr.push(line);
      if (this.recentStderr.length > 20) {
        this.recentStderr.shift();
      }
      this.logger.warn({ sessionId: this.sessionId, line }, "Pi stderr");
      this.emit("stderr", { sessionId: this.sessionId, line });
    });

    this.child.on("error", (error) => {
      this.logger.error({ sessionId: this.sessionId, err: error }, "Pi process error");
      this.#failPending(error);
    });

    this.child.on("exit", (code, signal) => {
      const stderrSuffix = this.recentStderr.length > 0
        ? ` stderr=${JSON.stringify(this.recentStderr[this.recentStderr.length - 1])}`
        : "";
      const error = new Error(
        `Pi process exited with code=${code ?? "null"} signal=${signal ?? "null"}${stderrSuffix}`
      );
      this.logger.warn({ sessionId: this.sessionId, code, signal }, "Pi process exited");

      const shouldRestart = !this.isStopping && !this.closed;
      this.child = null;
      this.#failPending(error);

      if (shouldRestart) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start().catch((restartError) => {
            this.logger.error({ sessionId: this.sessionId, err: restartError }, "Pi restart failed");
          });
        }, this.restartBackoffMs);
      }
    });
  }

  async stop() {
    this.closed = true;
    this.isStopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore forced-kill failures.
        }
        finish();
      }, 3000);

      child.once("exit", () => {
        finish();
      });

      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch {
        // Ignore stdin close failures.
      }

      try {
        child.kill();
      } catch {
        finish();
      }
    });
  }

  async prompt(message, options = {}) {
    await this.start();

    if (this.currentRun) {
      throw new Error("Session is busy");
    }

    const id = randomUUID();
    const run = {
      id,
      startedAt: Date.now(),
      request: {
        id,
        type: "prompt",
        message,
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {})
      },
      responseText: "",
      latestMessage: null,
      timeout: null,
      resolve: null,
      reject: null
    };

    const result = await new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
      run.timeout = setTimeout(() => {
        this.abortCurrentRun(new Error(`Request timeout after ${this.requestTimeoutMs}ms`)).catch(() => {});
      }, this.requestTimeoutMs);

      this.currentRun = run;
      this.pendingResponses.set(id, run);

      try {
        this.#write(run.request);
      } catch (error) {
        this.#clearRun(run);
        reject(error);
      }
    });

    return result;
  }

  async abortCurrentRun(reason = new Error("Aborted")) {
    const run = this.currentRun;
    if (!run) {
      throw reason;
    }

    try {
      this.#write({ type: "abort" });
    } catch (error) {
      this.logger.warn({ sessionId: this.sessionId, err: error }, "Abort write failed");
    }

    this.#finalizeRunWithError(run, reason);
    throw reason;
  }

  #write(payload) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Pi stdin is not available");
    }

    const line = `${JSON.stringify(payload)}\n`;
    const canWrite = this.child.stdin.write(line);
    if (!canWrite) {
      this.logger.debug({ sessionId: this.sessionId }, "Pi stdin backpressure");
    }
  }

  #handleStdoutLine(line) {
    if (!line) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger.warn({ sessionId: this.sessionId, line, err: error }, "Invalid JSONL from Pi");
      this.emit("rpc_parse_error", { sessionId: this.sessionId, line });
      return;
    }

    this.emit("event", { sessionId: this.sessionId, event: message });

    if (message.type === "response") {
      const run = message.id ? this.pendingResponses.get(message.id) : null;
      if (run && message.success === false) {
        this.#finalizeRunWithError(run, new Error(message.error || "Pi rejected prompt"));
      }
      return;
    }

    const run = this.currentRun;
    if (!run) {
      return;
    }

    if (message.type === "message_update") {
      const event = message.assistantMessageEvent || {};
      if (event.type === "text_delta" && typeof event.delta === "string") {
        run.responseText += event.delta;
      }
      if (message.message) {
        run.latestMessage = message.message;
      }
      return;
    }

    if (message.type === "message_end" && message.message) {
      run.latestMessage = message.message;
      return;
    }

    if (message.type === "agent_end") {
      const assistantMessages = Array.isArray(message.messages)
        ? message.messages.filter((entry) => entry && entry.role === "assistant")
        : [];

      const fallbackText = assistantMessages.map(extractAssistantText).filter(Boolean).join("\n\n");
      const responseText = run.responseText || fallbackText;

      this.#finalizeRun(run, {
        response: responseText,
        messages: message.messages || [],
        latestMessage: run.latestMessage
      });
      return;
    }

    if (message.type === "extension_ui_request") {
      this.#write({
        type: "extension_ui_response",
        id: message.id,
        cancelled: true
      });
      return;
    }

    if (message.type === "message_update" && message.assistantMessageEvent?.type === "error") {
      this.#finalizeRunWithError(run, new Error(message.assistantMessageEvent.reason || "Pi stream error"));
    }
  }

  #clearRun(run) {
    if (run.timeout) {
      clearTimeout(run.timeout);
    }

    this.pendingResponses.delete(run.id);
    if (this.currentRun?.id === run.id) {
      this.currentRun = null;
    }
  }

  #finalizeRun(run, payload) {
    this.#clearRun(run);
    run.resolve(payload);
  }

  #finalizeRunWithError(run, error) {
    this.#clearRun(run);
    run.reject(error);
  }

  #failPending(error) {
    const run = this.currentRun;
    if (run) {
      this.#finalizeRunWithError(run, error);
    }

    for (const pendingRun of this.pendingResponses.values()) {
      if (pendingRun !== run) {
        this.#finalizeRunWithError(pendingRun, error);
      }
    }
  }
}

function resolveSpawnCommand(piPath, args) {
  if (process.platform !== "win32") {
    return {
      command: piPath,
      args
    };
  }

  const resolvedPath = resolveWindowsCommand(piPath);
  const extension = path.extname(resolvedPath).toLowerCase();

  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedPath, ...args]
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: resolvedPath,
      args,
      spawnOptions: {
        shell: true
      }
    };
  }

  return {
    command: resolvedPath,
    args
  };
}


function resolveWindowsCommand(command) {
  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    const matches = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const preferred = [".cmd", ".bat", ".exe", ".com", ".ps1", ""];
    matches.sort((left, right) => {
      const leftExt = path.extname(left).toLowerCase();
      const rightExt = path.extname(right).toLowerCase();
      return preferred.indexOf(leftExt) - preferred.indexOf(rightExt);
    });

    return matches[0] || command;
  } catch {
    return command;
  }
}
