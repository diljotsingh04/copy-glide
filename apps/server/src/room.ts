// One UserRoom per account. Every signed-in device holds a WebSocket to it.
// Clips (already encrypted by the client) are stored here and relayed to the other devices.
// Uses the WebSocket Hibernation API so idle connections cost (almost) nothing.
import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_DEVICE_REMOVED,
  HISTORY_LIMIT,
  type ClientMessage,
  type ClipEnvelope,
  type ServerMessage,
} from '@copyglide/shared/src/protocol';

const MAX_CT_CHARS = 400_000; // ~300 KB ciphertext, well under the 1 MiB WebSocket message limit
const REPLAY_BATCH = 50;

export class UserRoom extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      ct TEXT NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS clips_created ON clips(created_at)');
    // Answer keep-alive pings without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const deviceId = request.headers.get('X-Device-Id');
      if (!deviceId) return new Response('missing device', { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [deviceId]);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/kick') {
      const deviceId = url.searchParams.get('device') ?? '';
      for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(CLOSE_DEVICE_REMOVED, 'device removed');
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const deviceId = this.ctx.getTags(ws)[0];

    switch (msg.t) {
      case 'sync': {
        const since = Number(msg.since) || 0;
        const rows = this.sql
          .exec(
            `SELECT id, device_id AS deviceId, created_at AS createdAt, nonce, ct FROM clips
             WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
            since,
            HISTORY_LIMIT,
          )
          .toArray() as unknown as ClipEnvelope[];
        rows.reverse(); // oldest first
        for (let i = 0; i < rows.length; i += REPLAY_BATCH) {
          this.send(ws, { t: 'clips', clips: rows.slice(i, i + REPLAY_BATCH), replay: true });
        }
        break;
      }

      case 'push': {
        const c = msg.clip;
        if (
          !c ||
          typeof c.id !== 'string' ||
          c.id.length > 64 ||
          typeof c.nonce !== 'string' ||
          typeof c.ct !== 'string' ||
          c.ct.length > MAX_CT_CHARS
        ) {
          this.send(ws, { t: 'error', message: 'Invalid or too large clip' });
          return;
        }
        const last = (this.sql.exec('SELECT MAX(created_at) AS m FROM clips').one().m as number | null) ?? 0;
        const clip: ClipEnvelope = {
          id: c.id,
          deviceId,
          createdAt: Math.max(Date.now(), last + 1),
          nonce: c.nonce,
          ct: c.ct,
        };
        this.sql.exec(
          'INSERT OR IGNORE INTO clips (id, device_id, created_at, nonce, ct) VALUES (?, ?, ?, ?, ?)',
          clip.id,
          clip.deviceId,
          clip.createdAt,
          clip.nonce,
          clip.ct,
        );
        this.sql.exec(
          'DELETE FROM clips WHERE id NOT IN (SELECT id FROM clips ORDER BY created_at DESC LIMIT ?)',
          HISTORY_LIMIT,
        );
        this.broadcast({ t: 'clips', clips: [clip], replay: false });
        break;
      }

      case 'delete': {
        if (typeof msg.id !== 'string') return;
        this.sql.exec('DELETE FROM clips WHERE id = ?', msg.id);
        this.broadcast({ t: 'deleted', ids: [msg.id] });
        break;
      }

      case 'clear': {
        this.sql.exec('DELETE FROM clips');
        this.broadcast({ t: 'cleared' });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* socket gone */
      }
    }
  }
}
