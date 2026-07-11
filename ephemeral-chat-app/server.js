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
      
      // Broadcast prune event to all connected clients so they clean their screens instantly
      const pruneNotice = JSON.stringify({ type: 'prune', cutoff });
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
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
  console.log('New client connected.');

  // 1. Send chat history to newly connected client
  db.all("SELECT * FROM messages ORDER BY timestamp ASC", [], (err, rows) => {
    if (err) {
      console.error('Failed to load history:', err.message);
      return;
    }
    
    // Send history packet
    ws.send(JSON.stringify({
      type: 'history',
      messages: rows
    }));
  });

  // 2. Handle incoming client messages
  ws.on('message', (messageString) => {
    try {
      const data = JSON.parse(messageString);
      
      if (data.type === 'message') {
        const { username, text, image } = data;
        const timestamp = Date.now();

        // Save to SQLite
        db.run(
          "INSERT INTO messages (username, text, image, timestamp) VALUES (?, ?, ?, ?)",
          [username, text, image, timestamp],
          function(err) {
            if (err) {
              console.error('Failed to save message:', err.message);
              return;
            }

            // Construct broadcast packet with database ID
            const broadcastMsg = JSON.stringify({
              type: 'message',
              message: {
                id: this.lastID,
                username,
                text,
                image,
                timestamp
              }
            });

            // Broadcast message to ALL connected clients
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(broadcastMsg);
              }
            });
          }
        );
      }
    } catch (parseErr) {
      console.error('Error parsing client payload:', parseErr.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected.');
  });
});

// Start listening
server.listen(PORT, () => {
  console.log(`VanishChat Server running on port ${PORT}`);
});
