import { EventEmitter } from "node:events";

import { PiProcess } from "./pi-process.js";

export class Session extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.sessionId;
    this.logger = options.logger;
    this.sessionTimeoutMs = options.sessionTimeoutMs;

    this.piProcess = new PiProcess(options);
    this.queue = Promise.resolve();
    this.pendingCount = 0;
    this.lastActiveAt = Date.now();
    this.idleTimer = null;
    this.deleted = false;

    this.piProcess.on("event", (payload) => {
      this.lastActiveAt = Date.now();
      this.emit("event", payload);
    });

    this.piProcess.on("stderr", (payload) => {
      this.emit("stderr", payload);
    });

    this.piProcess.on("rpc_parse_error", (payload) => {
      this.emit("rpc_parse_error", payload);
    });
  }

  async start() {
    this.#touch();
    await this.piProcess.start();
  }

  async prompt(message) {
    if (this.deleted) {
      throw new Error("Session already deleted");
    }

    this.pendingCount += 1;
    this.#touch();

    const job = async () => {
      this.#touch();
      const result = await this.piProcess.prompt(message);
      this.#touch();
      return result;
    };

    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});

    try {
      return await run;
    } finally {
      this.pendingCount -= 1;
      this.#touch();
    }
  }

  async stop() {
    this.deleted = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.piProcess.stop();
  }

  getState() {
    return {
      sessionId: this.id,
      pendingCount: this.pendingCount,
      lastActiveAt: this.lastActiveAt
    };
  }

  #touch() {
    this.lastActiveAt = Date.now();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      if (this.pendingCount > 0 || this.deleted) {
        this.#touch();
        return;
      }

      this.emit("idle_timeout", { sessionId: this.id });
    }, this.sessionTimeoutMs);
  }
}
