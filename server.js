import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import net from 'net';

const PORT = process.env.PORT || 8080;
const TUNNEL_PORT = process.env.TUNNEL_PORT || 8081;

// Store connected clients: userId -> { ws, username, status, server, publicIp, publicPort }
const clients = new Map();

// Tunnel registry: tunnelId -> { hostSocket, pendingClients: [socket...] }
const tunnels = new Map();

// ============================================================================
// HTTP Health Check + WebSocket Signaling (port 8080)
// ============================================================================
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            connected: clients.size,
            activeTunnels: tunnels.size,
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('PTG+ Relay Server');
    }
});

// Attach WebSocket server to the HTTP server so both share port 8080
const wss = new WebSocketServer({ server });

console.log(`PTG+ Relay Server starting on port ${PORT}`);
console.log(`PTG+ Tunnel Server will start on port ${TUNNEL_PORT}`);

wss.on('connection', (ws, req) => {
    let userId = null;
    let username = null;

    // Capture public IP + port from the TCP connection itself.
    const publicIp = req.socket.remoteAddress.replace(/^::ffff:/, '');
    const publicPort = req.socket.remotePort;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            switch (msg.type) {
                case 'login':
                    // Collision check — if userId is already in use by an active client,
                    // reject the login so the client can regenerate its code (Option B)
                    const existing = clients.get(msg.userId);
                    if (existing && existing.ws && existing.ws.readyState === 1) {
                        console.log(`[${new Date().toISOString()}] Login rejected — code ${msg.userId} already in use by ${existing.username}`);
                        ws.send(JSON.stringify({
                            type: 'loginError',
                            reason: 'code_in_use'
                        }));
                        return;  // Don't set userId/username, don't add to clients
                    }

                    userId = msg.userId;
                    username = msg.username || 'Player';
                    clients.set(userId, {
                        ws, username,
                        status: 'online', server: '',
                        publicIp, publicPort
                    });
                    console.log(`[${new Date().toISOString()}] ${username} (${userId}) @ ${publicIp}:${publicPort} logged in. Total: ${clients.size}`);

                    ws.send(JSON.stringify({
                        type: 'loginSuccess',
                        userId: userId,
                        onlineCount: clients.size,
                        tunnelPort: TUNNEL_PORT  // Tell client what port to use for tunneling
                    }));

                    broadcast(userId, JSON.stringify({
                        type: 'friendStatus',
                        friendId: userId,
                        friendName: username,
                        status: 'online',
                        server: ''
                    }));
                    break;

                case 'getFriendStatuses':
                    // Client requests current status of their friends (sent right after login)
                    // Returns the status of each friend who is currently online
                    const friendIds = msg.friendIds || [];
                    const statuses = [];
                    for (const fid of friendIds) {
                        const friend = clients.get(fid);
                        if (friend && friend.ws.readyState === 1) {
                            statuses.push({
                                id: fid,	
                                status: friend.status || 'online',
                                server: friend.server || '',
                                name: friend.username
                            });
                        }
                    }
                    ws.send(JSON.stringify({
                        type: 'friendStatuses',
                        statuses: statuses
                    }));
                    break;

                case 'addFriend':
                    const target = clients.get(msg.friendId);
                    if (target && target.ws.readyState === 1) {
                        target.ws.send(JSON.stringify({
                            type: 'friendRequest',
                            fromId: userId,
                            fromName: username
                        }));
                        ws.send(JSON.stringify({ type: 'friendRequestSent', success: true }));
                    } else {
                        ws.send(JSON.stringify({ type: 'friendRequestSent', success: false, reason: 'User not online' }));
                    }
                    break;

                case 'friendAccept':
                    const requester = clients.get(msg.friendId);
                    if (requester && requester.ws.readyState === 1) {
                        requester.ws.send(JSON.stringify({
                            type: 'friendAccepted',
                            friendId: userId,
                            friendName: username
                        }));
                    }
                    ws.send(JSON.stringify({
                        type: 'friendAccepted',
                        friendId: msg.friendId,
                        friendName: requester ? requester.username : 'Unknown'
                    }));
                    break;

                case 'worldInvite':
                    // Forward invite to friend with hole-punch endpoint info AND tunnel ID
                    const friend = clients.get(msg.friendId);
                    if (friend && friend.ws.readyState === 1) {
                        friend.ws.send(JSON.stringify({
                            type: 'worldInvite',
                            fromId: userId,
                            fromName: username,
                            ip: msg.ip,
                            port: msg.port,
                            worldName: msg.worldName || 'Minecraft World',
                            // Hole-punch info
                            hostPublicIp: publicIp,
                            hostPublicPort: publicPort,
                            friendPublicIp: friend.publicIp,
                            friendPublicPort: friend.publicPort,
                            // Phase 3: tunnel ID for fallback
                            tunnelId: msg.tunnelId || null,
                            tunnelPort: TUNNEL_PORT
                        }));

                        ws.send(JSON.stringify({
                            type: 'peerEndpoint',
                            friendId: msg.friendId,
                            friendName: friend.username,
                            friendPublicIp: friend.publicIp,
                            friendPublicPort: friend.publicPort,
                            hostPublicIp: publicIp,
                            hostPublicPort: publicPort
                        }));

                        ws.send(JSON.stringify({ type: 'inviteSent', success: true }));
                    } else {
                        ws.send(JSON.stringify({ type: 'inviteSent', success: false, reason: 'Friend not online' }));
                    }
                    break;

                case 'status':
                    const client = clients.get(userId);
                    if (client) {
                        client.status = msg.status || 'online';
                        client.server = msg.server || '';
                        broadcast(userId, JSON.stringify({
                            type: 'friendStatus',
                            friendId: userId,
                            friendName: username,
                            status: client.status,
                            server: client.server
                        }));
                    }
                    break;

                case 'joinRequest':
                    // Friend wants to join our world (for joinMode ON/HOSTING)
                    const joinTarget = clients.get(msg.friendId);
                    if (joinTarget && joinTarget.ws.readyState === 1) {
                        joinTarget.ws.send(JSON.stringify({
                            type: 'joinRequest',
                            fromId: userId,
                            fromName: username
                        }));
                        ws.send(JSON.stringify({ type: 'joinRequestSent', success: true }));
                    } else {
                        ws.send(JSON.stringify({ type: 'joinRequestSent', success: false, reason: 'Friend not online' }));
                    }
                    break;

                case 'joinAccept':
                    // Host accepts the join request — sends a world invite back
                    const joinFriend = clients.get(msg.friendId);
                    if (joinFriend && joinFriend.ws.readyState === 1) {
                        joinFriend.ws.send(JSON.stringify({
                            type: 'worldInvite',
                            fromId: userId,
                            fromName: username,
                            ip: msg.ip || '',
                            port: msg.port || 0,
                            worldName: msg.worldName || 'Minecraft World',
                            hostPublicIp: publicIp,
                            hostPublicPort: publicPort,
                            friendPublicIp: joinFriend.publicIp,
                            friendPublicPort: joinFriend.publicPort,
                            tunnelId: msg.tunnelId || null,
                            tunnelPort: TUNNEL_PORT
                        }));
                        console.log(`[TUNNEL] Join accepted — invite sent to ${joinFriend.username}`);
                    }
                    break;

                case 'chat':
                    const recipient = clients.get(msg.friendId);
                    if (recipient && recipient.ws.readyState === 1) {
                        recipient.ws.send(JSON.stringify({
                            type: 'chat',
                            fromId: userId,
                            fromName: username,
                            message: msg.message
                        }));
                    }
                    break;

                case 'partyInvite':
                    const partyFriend = clients.get(msg.friendId);
                    if (partyFriend && partyFriend.ws.readyState === 1) {
                        partyFriend.ws.send(JSON.stringify({
                            type: 'partyInvite',
                            fromId: userId,
                            fromName: username,
                            partyId: msg.partyId
                        }));
                    }
                    break;

                case 'resourcePackInfo':
                    // Forward resource pack list to the friend
                    const rpFriend = clients.get(msg.friendId);
                    if (rpFriend && rpFriend.ws.readyState === 1) {
                        rpFriend.ws.send(JSON.stringify({
                            type: 'resourcePackInfo',
                            fromName: username,
                            packs: msg.packs || []
                        }));
                        console.log(`[TUNNEL] Forwarded ${msg.packs ? msg.packs.length : 0} resource packs to ${rpFriend.username}`);
                    }
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
            console.log(`[${new Date().toISOString()}] ${username} (${userId}) disconnected. Total: ${clients.size}`);
            broadcast(userId, JSON.stringify({
                type: 'friendStatus',
                friendId: userId,
                friendName: username,
                status: 'offline',
                server: ''
            }));
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

function broadcast(excludeUserId, message) {
    clients.forEach((client, id) => {
        if (id !== excludeUserId && client.ws.readyState === 1) {
            client.ws.send(message);
        }
    });
}

// ============================================================================
// TCP Tunnel Server (port 8081) — Phase 3
// ----------------------------------------------------------------------------
// Protocol:
//   Client connects, sends one of:
//     HOST <tunnelId>\n    — host registers a tunnel (control channel)
//     CLIENT <tunnelId>\n  — friend wants to connect to host's tunnel
//     DATA <tunnelId>\n    — host opens a data channel in response to INCOMING
//
// Flow:
//   1. Host opens persistent TCP, sends HOST, relay replies READY, keeps open
//   2. Friend opens TCP, sends CLIENT
//   3. Relay sends INCOMING on host's control socket
//   4. Host opens NEW TCP, sends DATA
//   5. Relay pairs friend's CLIENT socket with host's DATA socket, pipes bytes
//   6. Host also pipes DATA socket to localhost:lanPort (its MC server)
// ============================================================================
const tunnelServer = net.createServer((socket) => {
    let identified = false;
    let mode = null;
    let tunnelId = null;
    let buffer = '';

    socket.on('data', (data) => {
        if (!identified) {
            buffer += data.toString('binary');
            const newlineIdx = buffer.indexOf('\n');
            if (newlineIdx === -1) {
                if (buffer.length > 1024) {
                    socket.destroy();
                }
                return;
            }

            const line = buffer.substring(0, newlineIdx).trim();
            const leftover = buffer.substring(newlineIdx + 1);
            buffer = '';
            identified = true;

            const parts = line.split(' ');
            mode = parts[0];
            tunnelId = parts[1];

            if (mode === 'HOST') {
                // Register host control channel
                if (!tunnels.has(tunnelId)) {
                    tunnels.set(tunnelId, { hostSocket: socket, pendingClients: [] });
                } else {
                    const t = tunnels.get(tunnelId);
                    // Close old host socket if any
                    if (t.hostSocket && t.hostSocket !== socket) {
                        try { t.hostSocket.destroy(); } catch (e) {}
                    }
                    t.hostSocket = socket;
                }
                socket.write('READY\n');
                console.log(`[TUNNEL] Host registered tunnel ${tunnelId}`);
                // After READY, this socket is a control channel — wait for INCOMING triggers
                // (any further data is ignored, only used to detect disconnect)
            } else if (mode === 'CLIENT') {
                // Friend wants to connect to a tunnel
                const tunnel = tunnels.get(tunnelId);
                if (!tunnel || !tunnel.hostSocket || tunnel.hostSocket.destroyed) {
                    socket.write('NO_HOST\n');
                    socket.end();
                    return;
                }

                // Tell host to open a DATA connection
                try {
                    tunnel.hostSocket.write(`INCOMING ${tunnelId}\n`);
                } catch (e) {
                    socket.write('NO_HOST\n');
                    socket.end();
                    return;
                }

                // Queue this CLIENT socket until a DATA socket arrives
                tunnel.pendingClients.push({ socket, leftover });
                console.log(`[TUNNEL] Client waiting for tunnel ${tunnelId} (queue: ${tunnel.pendingClients.length})`);

                // Set a timeout — if no DATA arrives in 10s, give up
                setTimeout(() => {
                    const idx = tunnel.pendingClients.findIndex(c => c.socket === socket);
                    if (idx !== -1) {
                        tunnel.pendingClients.splice(idx, 1);
                        try { socket.write('TIMEOUT\n'); } catch (e) {}
                        try { socket.end(); } catch (e) {}
                        console.log(`[TUNNEL] Client timed out waiting for tunnel ${tunnelId}`);
                    }
                }, 10000);
            } else if (mode === 'DATA') {
                // Host opened a DATA connection in response to INCOMING
                const tunnel = tunnels.get(tunnelId);
                if (!tunnel || tunnel.pendingClients.length === 0) {
                    socket.write('NO_CLIENT\n');
                    socket.end();
                    return;
                }

                const client = tunnel.pendingClients.shift();
                console.log(`[TUNNEL] Pairing DATA + CLIENT for tunnel ${tunnelId}`);

                // Write any leftover bytes from CLIENT side to DATA side
                if (client.leftover && client.leftover.length > 0) {
                    socket.write(Buffer.from(client.leftover, 'binary'));
                }
                // Write any leftover bytes from DATA side to CLIENT side
                if (leftover.length > 0) {
                    client.socket.write(Buffer.from(leftover, 'binary'));
                }

                // Now pipe bytes between them
                pipeSockets(client.socket, socket);
            } else {
                socket.destroy();
            }
        }
    });

    socket.on('error', () => {
        // Silent — errors are expected when sockets close
    });

    socket.on('close', () => {
        if (mode === 'HOST' && tunnelId) {
            const tunnel = tunnels.get(tunnelId);
            if (tunnel && tunnel.hostSocket === socket) {
                console.log(`[TUNNEL] Host disconnected for tunnel ${tunnelId}`);
                tunnels.delete(tunnelId);
            }
        }
    });
});

function pipeSockets(a, b) {
    a.pipe(b);
    b.pipe(a);
    const cleanup = () => {
        try { a.destroy(); } catch (e) {}
        try { b.destroy(); } catch (e) {}
    };
    a.on('close', cleanup);
    b.on('close', cleanup);
    a.on('error', cleanup);
    b.on('error', cleanup);
}

tunnelServer.listen(TUNNEL_PORT, () => {
    console.log(`Tunnel server listening on port ${TUNNEL_PORT}`);
});

tunnelServer.on('error', (err) => {
    console.error('Tunnel server error:', err.message);
});

// Start the HTTP + WebSocket server on the main port
server.listen(PORT, () => {
    console.log(`HTTP + WebSocket server listening on port ${PORT}`);
});

server.on('error', (err) => {
    console.error('HTTP server error:', err.message);
});
