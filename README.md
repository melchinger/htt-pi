# htt-pi

Pi-RPC Netzwerk-Wrapper

Lizenz: MIT, siehe `LICENSE`.

Lokaler Fastify-Dienst, der `pi --mode rpc --no-session` pro `session_id` kapselt und per HTTP sowie WebSocket zugreifbar macht.

## Features

- Eine Pi-Instanz pro Session
- Sequentielle Request-Verarbeitung pro Session
- Automatischer Neustart bei Prozessabsturz
- Idle-Timeout mit Session-Cleanup
- HTTP API fuer PHP oder andere lokale Clients
- Optionales Event-Streaming per WebSocket
- API-Key, Body-Limit und Rate-Limit

## Setup

```bash
npm install
copy .env.example .env
npm start
```

## Konfiguration

```env
HOST=127.0.0.1
PORT=3100
API_KEY=
PI_PATH=pi
PI_ARGS=
MAX_SESSIONS=10
SESSION_TIMEOUT_MS=900000
REQUEST_TIMEOUT_MS=60000
INPUT_MAX_BYTES=65536
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW=1 minute
RESTART_BACKOFF_MS=1000
```

## HTTP API

### `POST /session/create`

```json
{
  "session_id": "php-worker-1"
}
```

### `POST /session/delete`

```json
{
  "session_id": "php-worker-1"
}
```

### `POST /prompt`

```json
{
  "session_id": "php-worker-1",
  "message": "Analysiere dieses Projekt"
}
```

Antwort:

```json
{
  "status": "ok",
  "response": "..."
}
```

## WebSocket

`GET /stream?session_id=php-worker-1`

Der Stream liefert rohe Pi-Events sowie `stderr` und Parse-Fehler als JSON.

## Verhalten

- Existiert eine Session bei `/prompt` noch nicht, wird sie automatisch angelegt.
- Pro Session wird immer nur ein Prompt gleichzeitig an Pi uebergeben.
- Bei einem Pi-Absturz wird der Prozess fuer die Session automatisch neu gestartet.
- Nach `SESSION_TIMEOUT_MS` Inaktivitaet wird die Session beendet.

## Hinweise

- Der Wrapper bindet standardmaessig nur an `127.0.0.1`.
- `--no-session` bedeutet: Kontext lebt im jeweiligen Pi-Prozess, nicht in persistierten Pi-Sessiondateien.
- Falls Pi zusaetzliche CLI-Optionen braucht, koennen sie ueber `PI_ARGS` gesetzt werden.

## Repository-Hygiene

- Lokale Artefakte sind ueber `.gitignore` ausgeschlossen, darunter `node_modules/`, `dist/`, `build/`, `coverage/`, Temp-Verzeichnisse, Logs und Editor-Metadaten.
- `.env` ist bewusst ignoriert, `.env.example` bleibt versioniert.
- `package-lock.json` bleibt bewusst versioniert, damit Installationen reproduzierbar bleiben.
