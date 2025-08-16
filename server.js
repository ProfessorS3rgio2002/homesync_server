const net = require('net');

const PORT = Number(process.env.PORT || 6222);
const startedAt = Date.now();
let connectionId = 0;
let activeConnections = 0;
const clients = new Set();
const pendingRequests = new Map(); // id -> { requesters: Set<socket>, timer: Timeout }
const REQUEST_TIMEOUT_MS = 10000;

// Simple line-oriented protocol:
// - CLIENT sends lines (\n-terminated). Commands are case-insensitive.
// - HEALTH  -> server responds with one JSON line: { status: 'ok', uptimeSeconds, startedAt, port }
// - PING    -> server responds with: PONG
// - QUIT    -> server closes the socket
// - any other line -> echoed back prefixed with ECHO:

function handleLine(socket, line) {
  const cmd = (line || '').trim();
  if (!cmd) return;
  // debug: log the received (parsed) command/line
  try {
    console.log(new Date().toISOString(), `client:${socket.clientId||'?'} recv_cmd`, cmd);
  } catch (e) {
    console.log(new Date().toISOString(), 'recv_cmd', cmd);
  }
  // Recognize TYPE headers like: TYPE:ESP32 or TYPE:MOBILE or TYPE:ESP32:deviceId
  if (cmd.toUpperCase().startsWith('TYPE:')) {
    const rest = cmd.slice(5).trim();
    // allow TYPE:ESP32 or TYPE:MOBILE or TYPE:ESP32:123
    const parts = rest.split(':').map(s => s.trim()).filter(Boolean);
    socket.deviceType = parts[0] ? parts[0].toUpperCase() : undefined;
    socket.deviceId = parts[1] || undefined;
    console.log(new Date().toISOString(), `client:${socket.clientId} identified as`, socket.deviceType, socket.deviceId ? `id=${socket.deviceId}` : '');
    socket.write(`OK TYPE ${socket.deviceType}${socket.deviceId ? ' id='+socket.deviceId : ''}\n`);
    return;
  }

  if (cmd.toUpperCase() === 'LIST') {
    const arr = Array.from(clients).map(c => ({ clientId: c.clientId, remote: c.remoteInfo, type: c.deviceType || 'UNKNOWN', id: c.deviceId || null }));
    try { socket.write(JSON.stringify(arr) + '\n'); } catch (e) { }
    return;
  }

  // If the line looks like JSON, parse it and handle structured messages
  if (cmd.startsWith('{') && cmd.endsWith('}')) {
    let obj;
    try {
      obj = JSON.parse(cmd);
    } catch (e) {
      console.log(new Date().toISOString(), `client:${socket.clientId} invalid_json`, e && e.message ? e.message : e);
      socket.write('ERROR invalid_json\n');
      return;
    }

    // handle ping type
    if (obj.type === 'ping') {
      socket.write('PONG\n');
      return;
    }

    // handle request_state from mobile: register pending requester and forward request to ESP32s
    if (obj.type === 'request_state') {
      const targetId = obj.id != null ? String(obj.id) : undefined;
      if (!targetId) {
        socket.write('ERROR missing_id\n');
        return;
      }

      // add requester to pendingRequests
      let entry = pendingRequests.get(targetId);
      if (!entry) {
        entry = { requesters: new Set(), timer: null };
        pendingRequests.set(targetId, entry);
      }
      entry.requesters.add(socket);
      // reset timer
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        try {
          for (const req of entry.requesters) {
            try { req.write(JSON.stringify({ type: 'error', id: targetId, error: 'timeout' }) + '\n'); } catch (e) { }
          }
        } finally {
          pendingRequests.delete(targetId);
        }
      }, REQUEST_TIMEOUT_MS);

      // forward the original request JSON to all ESP32s
      const msg = JSON.stringify(obj) + '\n';
      let forwarded = 0;
      const esp32s = Array.from(clients).filter(c => c.deviceType === 'ESP32');
      console.log(new Date().toISOString(), `client:${socket.clientId} request_state will forward to esp32_count=${esp32s.length}`, esp32s.map(c => ({ clientId: c.clientId, remote: c.remoteInfo })));
      for (const c of esp32s) {
        try {
          c.write(msg);
          forwarded++;
          console.log(new Date().toISOString(), `client:${socket.clientId} forwarded request_state to client:${c.clientId} remote=${c.remoteInfo}`);
        } catch (e) {
          console.log(new Date().toISOString(), `forward_error to client:${c.clientId}`, e && e.message ? e.message : e);
        }
      }
      socket.write(`ACK request_state forwarded=${forwarded}\n`);
      console.log(new Date().toISOString(), `client:${socket.clientId} request_state id=${targetId} forwarded=${forwarded} pending=${entry.requesters.size}`);
      return;
    }

    // handle toggle: broadcast to all connected ESP32 clients (ignore id)
    if (obj.type === 'toggle') {
      const msg = JSON.stringify(obj) + '\n';
      let forwarded = 0;
      for (const c of clients) {
        if (c === socket) continue; // don't echo back to sender
        if (c.deviceType === 'ESP32') {
          try {
            c.write(msg);
            forwarded++;
          } catch (e) {
            console.log(new Date().toISOString(), `forward_error to client:${c.clientId}`, e && e.message ? e.message : e);
          }
        }
      }
      socket.write(`ACK forwarded=${forwarded}\n`);
      console.log(new Date().toISOString(), `client:${socket.clientId} toggle broadcast forwarded=${forwarded}`);
      return;
    }

    // handle response messages from ESP32 (or others): forward ack/state to pending requesters or MOBILE clients
    if ((obj.type === 'ack' || obj.type === 'state') && obj.id != null) {
      const targetId = String(obj.id);
      const msg = JSON.stringify(obj) + '\n';
      let receivers = 0;
      const entry = pendingRequests.get(targetId);
      if (entry) {
        for (const req of entry.requesters) {
          try { req.write(msg); receivers++; } catch (e) { console.log(new Date().toISOString(), `forward_error to requester`, e && e.message ? e.message : e); }
        }
        // keep pendingRequests until timeout to allow multiple responses within window
      } else {
        // no pending requesters: broadcast to all MOBILE clients
        for (const c of clients) {
          if (c.deviceType === 'MOBILE') {
            try { c.write(msg); receivers++; } catch (e) { console.log(new Date().toISOString(), `forward_error to mobile:${c.clientId}`, e && e.message ? e.message : e); }
          }
        }
      }
      socket.write('ACK\n');
      console.log(new Date().toISOString(), `client:${socket.clientId} ${obj.type} forwarded_to_requesters=${receivers} id=${obj.id}`);
      return;
    }

    // unknown structured message
    socket.write('ACK\n');
    return;
  }
  if (cmd.toUpperCase() === 'HEALTH') {
    const payload = {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      port: PORT,
    };
    socket.write(JSON.stringify(payload) + '\n');
    return;
  }

  if (cmd.toUpperCase() === 'PING') {
    socket.write('PONG\n');
    return;
  }

  if (cmd.toUpperCase() === 'QUIT') {
    socket.end('BYE\n');
    return;
  }

  // default: echo
  socket.write(`ECHO: ${cmd}\n`);
}

const server = net.createServer((socket) => {
  const id = ++connectionId;
  activeConnections++;
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(new Date().toISOString(), `client:${id} connected`, remote, `active=${activeConnections}`);
  socket.clientId = id;
  socket.remoteInfo = remote;
  // track sockets so we can forward between them
  clients.add(socket);
  socket.setEncoding('utf8');
  socket.write('Homesync Online TCP server. Send HEALTH, PING, or QUIT.\n');

  let buffer = '';
  socket.on('data', (chunk) => {
    // debug: log raw data chunk as received from the socket
    try {
      console.log(new Date().toISOString(), `client:${socket.clientId||'?'} data_chunk`, JSON.stringify(chunk));
    } catch (e) {
      console.log(new Date().toISOString(), 'data_chunk', String(chunk));
    }
    buffer += chunk;
    // split into lines
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      try {
        handleLine(socket, line);
      } catch (err) {
        console.error('handleLine error:', err && err.message ? err.message : err);
        socket.write('ERROR\n');
      }
    }
  });

  socket.on('close', (hadError) => {
    activeConnections = Math.max(0, activeConnections - 1);
    console.log(new Date().toISOString(), 'close', remote, `client:${id}`, 'hadError=', hadError, `active=${activeConnections}`);
  clients.delete(socket);
  // remove socket from any pendingRequests
  for (const [key, entry] of pendingRequests.entries()) {
    if (entry.requesters.has(socket)) {
      entry.requesters.delete(socket);
      if (entry.requesters.size === 0) {
        if (entry.timer) clearTimeout(entry.timer);
        pendingRequests.delete(key);
      }
    }
  }
  });

  socket.on('error', (err) => {
    console.error(new Date().toISOString(), 'socket error', remote, err && err.message ? err.message : err);
  });
});

server.on('error', (err) => {
  console.error('Server error:', err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Homesync Online TCP server listening on port ${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`${signal} received, shutting down server...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
