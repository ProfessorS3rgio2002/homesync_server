const net = require('net');

const PORT = Number(process.env.PORT || 6222);
const startedAt = Date.now();
let connectionId = 0;
let activeConnections = 0;
const clients = new Set();

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

    // handle toggle: forward to ESP32 clients matching id (or broadcast if no id)
    if (obj.type === 'toggle') {
      const targetId = obj.id != null ? String(obj.id) : undefined;
      const msg = JSON.stringify(obj) + '\n';
      let forwarded = 0;
      for (const c of clients) {
        if (c === socket) continue; // don't echo back to sender
        if ((c.deviceType === 'ESP32') && (targetId === undefined || String(c.deviceId) === targetId)) {
          try {
            c.write(msg);
            forwarded++;
          } catch (e) {
            console.log(new Date().toISOString(), `forward_error to client:${c.clientId}`, e && e.message ? e.message : e);
          }
        }
      }
      socket.write(`ACK forwarded=${forwarded}\n`);
      console.log(new Date().toISOString(), `client:${socket.clientId} toggle forwarded=${forwarded} targetId=${targetId || '*'} `);
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
