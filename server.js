const net = require('net');

const PORT = Number(process.env.PORT || 6222);
const startedAt = Date.now();
let connectionId = 0;
let activeConnections = 0;

// Simple line-oriented protocol:
// - CLIENT sends lines (\n-terminated). Commands are case-insensitive.
// - HEALTH  -> server responds with one JSON line: { status: 'ok', uptimeSeconds, startedAt, port }
// - PING    -> server responds with: PONG
// - QUIT    -> server closes the socket
// - any other line -> echoed back prefixed with ECHO:

function handleLine(socket, line) {
  const cmd = (line || '').trim();
  if (!cmd) return;
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
  socket.setEncoding('utf8');
  socket.write('Homesync Online TCP server. Send HEALTH, PING, or QUIT.\n');

  let buffer = '';
  socket.on('data', (chunk) => {
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
