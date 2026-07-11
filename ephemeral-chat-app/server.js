const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8088;
const CHAT_PASSWORD = 'safechat';
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// In-Memory Message Storage
let messages = [];

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Auto-Prune Memory Array every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - EXPIRY_MS;
  const beforeLength = messages.length;
  messages = messages.filter(m => m.timestamp >= cutoff);
  const prunedCount = beforeLength - messages.length;
  
  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} expired messages from memory.`);
    
    // Broadcast prune notice to all connected clients
    const pruneNotice = JSON.stringify({ type: 'prune', cutoff });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
        client.send(pruneNotice);
      }
    });
  }
}, 15 * 60 * 1000);

// WebSocket Connections
wss.on('connection', (ws) => {
  ws.isAuthenticated = false;
  ws.username = null;

  ws.on('message', (messageString) => {
    try {
      const data = JSON.parse(messageString);

      // --- AUTHENTICATION ---
      if (data.type === 'join') {
        const { username, password } = data;

        if (password !== CHAT_PASSWORD) {
          ws.send(JSON.stringify({
            type: 'auth-error',
            message: 'Wrong password! Access denied.'
          }));
          ws.close();
          return;
        }

        ws.isAuthenticated = true;
        ws.username = username;
        console.log(`User connected: ${username}`);

        // Send memory history
        ws.send(JSON.stringify({
          type: 'history',
          messages: messages
        }));
        return;
      }

      // Drop messages from unauthenticated sockets
      if (!ws.isAuthenticated) {
        ws.close();
        return;
      }

      // --- TEXT & COMPRESSED BASE64 IMAGE MESSAGES ---
      if (data.type === 'message') {
        const { text, image } = data;
        const timestamp = Date.now();

        const msgObj = {
          id: Date.now() + Math.random().toString(36).substr(2, 4),
          username: ws.username,
          text,
          image,
          timestamp
        };

        // Push to memory array
        messages.push(msgObj);

        // Broadcast to all authenticated clients
        const broadcastPayload = JSON.stringify({
          type: 'message',
          message: msgObj
        });

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
            client.send(broadcastPayload);
          }
        });
      }

    } catch (err) {
      console.error('WS Error:', err.message);
    }
  });

  ws.on('close', () => {
    if (ws.username) {
      console.log(`User disconnected: ${ws.username}`);
    }
  });
});

// Fallback routing for SPA web loading
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`VanishChat Server running on port ${PORT}`);
});
