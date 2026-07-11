const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Initialize App
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8088;
const DB_PATH = path.join(__dirname, 'chat.db');

// Shared Chat Room Password
const CHAT_PASSWORD = 'safechat';

// Active voice call users list (username -> WebSocket)
const voiceUsers = new Map();

// Initialize SQLite Database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        text TEXT,
        image TEXT,
        timestamp INTEGER NOT NULL
      )
    `, (tableErr) => {
      if (tableErr) {
        console.error('Failed to create table:', tableErr.message);
      } else {
        console.log('Database tables ready.');
      }
    });
  }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback routing for Single Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 7-Day Ephemeral Cleanup Engine
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

function pruneExpiredMessages() {
  const cutoff = Date.now() - EXPIRY_MS;
  db.run("DELETE FROM messages WHERE timestamp < ?", [cutoff], function(err) {
    if (err) {
      console.error('Failed to prune database:', err.message);
    } else if (this.changes > 0) {
      console.log(`Pruned ${this.changes} expired messages from database.`);
      
      // Broadcast prune event to authenticated clients
      const pruneNotice = JSON.stringify({ type: 'prune', cutoff });
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
          client.send(pruneNotice);
        }
      });
    }
  });
}

// Check for expired messages every 15 minutes
setInterval(pruneExpiredMessages, 15 * 60 * 1000);
// Also run a prune check immediately on startup
setTimeout(pruneExpiredMessages, 5000);

// WebSocket real-time communication
wss.on('connection', (ws) => {
  console.log('A client connected (unauthenticated).');
  ws.isAuthenticated = false;
  ws.username = null;

  // Handle incoming client messages
  ws.on('message', (messageString) => {
    try {
      const data = JSON.parse(messageString);

      // --- AUTHENTICATION PHASE ---
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

        // Authenticate connection
        ws.isAuthenticated = true;
        ws.username = username;
        console.log(`User authenticated: ${username}`);

        // Send chat history
        db.all("SELECT * FROM messages ORDER BY timestamp ASC", [], (err, rows) => {
          if (err) {
            console.error('Failed to load history:', err.message);
            return;
          }
          ws.send(JSON.stringify({
            type: 'history',
            messages: rows
          }));

          // Send current voice participants list
          ws.send(JSON.stringify({
            type: 'voice-users-list',
            users: Array.from(voiceUsers.keys())
          }));
        });
        return;
      }

      // Drop messages from unauthenticated sockets
      if (!ws.isAuthenticated) {
        ws.close();
        return;
      }

      // --- AUTHENTICATED CHAT MESSAGE ---
      if (data.type === 'message') {
        const { text, image } = data;
        const timestamp = Date.now();

        // Save to SQLite
        db.run(
          "INSERT INTO messages (username, text, image, timestamp) VALUES (?, ?, ?, ?)",
          [ws.username, text, image, timestamp],
          function(err) {
            if (err) {
              console.error('Failed to save message:', err.message);
              return;
            }

            // Broadcast message
            const broadcastMsg = JSON.stringify({
              type: 'message',
              message: {
                id: this.lastID,
                username: ws.username,
                text,
                image,
                timestamp
              }
            });

            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                client.send(broadcastMsg);
              }
            });
          }
        );
      }

      // --- WEBRTC VOICE CALL STATE CHANNEL ---
      else if (data.type === 'voice-state') {
        const { joined } = data;
        if (joined) {
          voiceUsers.set(ws.username, ws);
          console.log(`${ws.username} joined voice call.`);
        } else {
          voiceUsers.delete(ws.username);
          console.log(`${ws.username} left voice call.`);
        }

        // Broadcast updated voice users list to everyone
        const listNotice = JSON.stringify({
          type: 'voice-users-list',
          users: Array.from(voiceUsers.keys())
        });
        
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
            client.send(listNotice);
          }
        });
      }

      // --- WEBRTC SIGNALING RELAY ---
      else if (data.type === 'signal') {
        const { to, signal } = data;
        const targetWs = voiceUsers.get(to);
        
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'signal',
            from: ws.username,
            signal: signal
          }));
        }
      }

    } catch (parseErr) {
      console.error('Error parsing client payload:', parseErr.message);
    }
  });

  // Client connection teardown
  ws.on('close', () => {
    if (ws.username) {
      console.log(`User left: ${ws.username}`);
      
      // Remove from voice list if they were speaking
      if (voiceUsers.has(ws.username)) {
        voiceUsers.delete(ws.username);
        
        // Broadcast updated voice users list
        const listNotice = JSON.stringify({
          type: 'voice-users-list',
          users: Array.from(voiceUsers.keys())
        });
        
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
            client.send(listNotice);
          }
        });
      }
    }
  });
});

// Start listening
server.listen(PORT, () => {
  console.log(`VanishChat Server running on port ${PORT}`);
});
