Homesync Online - minimal server

Files:
- server.js : simple Node TCP server implementing a line-oriented protocol.
- package.json : start script `node server.js`.

Run locally:

```powershell
cd f:\Homesync_online\server
npm install
npm start
```

Protocol (plain TCP, no HTTP):
Send newline-terminated commands (lines).
Commands (case-insensitive):
	- `HEALTH` -> server replies with one JSON line: { status, uptimeSeconds, startedAt, port }
	- `PING` -> replies `PONG`
	- `QUIT` -> server replies `BYE` and closes the connection
	- anything else -> echoed back as `ECHO: <your text>`

Quick tests (PowerShell):

# Use TCP client with .NET TcpClient
$client = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 6222)
$stream = $client.GetStream()
[byte[]]$buffer = 0..4095 | % {0}
[void]$stream.Write([System.Text.Encoding]::UTF8.GetBytes("HEALTH\n"), 0, 7)
#$ read response
#$n = $stream.Read($buffer, 0, $buffer.Length)
[System.Text.Encoding]::UTF8.GetString($buffer,0,$n)

Or using `nc` (if available) or Windows 10+ `Test-NetConnection` isn't a full client, so prefer a small script or `nc`.

The server listens on port 6222 by default or the `PORT` env var.
