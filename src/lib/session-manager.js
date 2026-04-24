import { Session } from "./session.js";

export class SessionManager {
  constructor(options) {
    this.options = options;
    this.sessions = new Map();
    this.wsClients = new Map();
    this.logger = options.logger;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  async createSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      return { session: this.sessions.get(sessionId), created: false };
    }

    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error("Maximum session count reached");
    }

    const session = new Session({
      ...this.options,
      sessionId
    });

    session.on("event", ({ event }) => {
      this.#broadcast(sessionId, { session_id: sessionId, event });
    });

    session.on("stderr", ({ line }) => {
      this.#broadcast(sessionId, { session_id: sessionId, stderr: line });
    });

    session.on("rpc_parse_error", ({ line }) => {
      this.#broadcast(sessionId, { session_id: sessionId, parse_error: line });
    });

    session.on("idle_timeout", async () => {
      this.logger.info({ sessionId }, "Session idle timeout reached");
      await this.deleteSession(sessionId);
    });

    this.sessions.set(sessionId, session);
    await session.start();
    return { session, created: true };
  }

  async getOrCreateSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const { session } = await this.createSession(sessionId);
    return session;
  }

  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.sessions.delete(sessionId);
    await session.stop();
    this.#broadcast(sessionId, { session_id: sessionId, event: { type: "session_deleted" } });
    this.#closeWsClients(sessionId);
    return true;
  }

  async prompt(sessionId, message) {
    const session = await this.getOrCreateSession(sessionId);
    return session.prompt(message);
  }

  attachWs(sessionId, socket) {
    const set = this.wsClients.get(sessionId) || new Set();
    set.add(socket);
    this.wsClients.set(sessionId, set);

    socket.on("close", () => {
      const clients = this.wsClients.get(sessionId);
      if (!clients) {
        return;
      }
      clients.delete(socket);
      if (clients.size === 0) {
        this.wsClients.delete(sessionId);
      }
    });
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => session.getState());
  }

  async shutdown() {
    await Promise.all(Array.from(this.sessions.keys()).map((sessionId) => this.deleteSession(sessionId)));
  }

  #broadcast(sessionId, payload) {
    const clients = this.wsClients.get(sessionId);
    if (!clients || clients.size === 0) {
      return;
    }

    const serialized = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(serialized);
      }
    }
  }

  #closeWsClients(sessionId) {
    const clients = this.wsClients.get(sessionId);
    if (!clients) {
      return;
    }

    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore close failures.
      }
    }

    this.wsClients.delete(sessionId);
  }
}
