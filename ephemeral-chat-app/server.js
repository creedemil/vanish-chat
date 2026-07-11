const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Initialize App
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8088;
const LOCAL_DB_PATH = path.join(__dirname, 'chat-data.json');
const CHAT_PASSWORD = 'safechat';
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// Support Raw Binary payloads for the /upload proxy route (up to 200 Megabytes)
app.use(express.raw({ limit: '200mb', type: '*/*' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================================
// PURE JAVASCRIPT DATABASE ENGINE (LOCAL JSON / FIREBASE CLOUD HYBRID)
// ==========================================================================

const cloudDbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/\/$/, "") : null;

if (cloudDbUrl) {
  console.log(`Cloud database detected: Using Firebase Realtime Database REST endpoint.`);
} else {
  console.log(`Using Local JSON file database at: ${LOCAL_DB_PATH}`);
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify([]));
  }
}

// Get all messages from DB
async function getMessagesFromDB() {
  if (cloudDbUrl) {
    try {
      const response = await fetch(`${cloudDbUrl}/messages.json`);
      const data = await response.json();
      if (!data) return [];
      
      // Firebase REST returns an object { key: message }
      const list = Object.keys(data).map(key => ({
        id: key,
        ...data[key]
      }));
      
      // Sort by timestamp
      return list.sort((a, b) => a.timestamp - b.timestamp);
    } catch (err) {
      console.error('Failed to fetch from Firebase:', err.message);
      return [];
    }
  } else {
    try {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('Failed to read local JSON database:', err.message);
      return [];
    }
  }
}

// Insert message to DB
async function insertMessageToDB(msg) {
  if (cloudDbUrl) {
    try {
      const response = await fetch(`${cloudDbUrl}/messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      });
      const data = await response.json();
      return { id: data.name, ...msg };
    } catch (err) {
      console.error('Failed to write to Firebase:', err.message);
      return { id: Date.now(), ...msg };
    }
  } else {
    try {
      const messages = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
      const newMsg = { id: Date.now() + Math.random().toString(36).substr(2, 4), ...msg };
      messages.push(newMsg);
      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(messages, null, 2));
      return newMsg;
    } catch (err) {
      console.error('Failed to write to local JSON database:', err.message);
      return { id: Date.now(), ...msg };
    }
  }
}

// Clean messages older than 7 days
async function pruneExpiredMessages() {
  const cutoff = Date.now() - EXPIRY_MS;
  let prunedCount = 0;

  if (cloudDbUrl) {
    try {
      const response = await fetch(`${cloudDbUrl}/messages.json`);
      const data = await response.json();
      if (!data) return;

      const keysToDelete = Object.keys(data).filter(key => data[key].timestamp < cutoff);
      prunedCount = keysToDelete.length;

      // Delete each expired key
      for (const key of keysToDelete) {
        await fetch(`${cloudDbUrl}/messages/${key}.json`, { method: 'DELETE' });
      }
      
      if (prunedCount > 0) {
        console.log(`Pruned ${prunedCount} cloud messages.`);
      }
    } catch (err) {
      console.error('Failed to prune Firebase database:', err.message);
    }
  } else {
    try {
      const messages = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
      const active = messages.filter(m => m.timestamp >= cutoff);
      prunedCount = messages.length - active.length;
      if (prunedCount > 0) {
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(active, null, 2));
        console.log(`Pruned ${prunedCount} local file database messages.`);
      }
    } catch (err) {
      console.error('Failed to prune local JSON database:', err.message);
    }
  }

  // Broadcast prune event to authenticated clients if database records were wiped
  if (prunedCount > 0) {
    const pruneNotice = JSON.stringify({ type: 'prune', cutoff });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
        client.send(pruneNotice);
      }
    });
  }
}

// Check for expired messages every 15 minutes
setInterval(pruneExpiredMessages, 15 * 60 * 1000);
// Run database prune check on startup
setTimeout(pruneExpiredMessages, 5000);

// ==========================================================================
// FILE UPLOAD PROXY (0X0.ST / CATBOX.MOE RELAY)
// ==========================================================================

app.post('/upload', async (req, res) => {
  try {
    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    const filename = req.headers['x-filename'] || 'upload_media';

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty file payload' });
    }

    console.log(`Uploading file ${filename} (${req.body.length} bytes, type ${mimeType})`);

    // Prepare binary Blob and Form Data for HTTP uploads
    const blob = new Blob([req.body], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, filename);

    let fileUrl = null;

    // Try 0x0.st first (fast, direct curl upload endpoint)
    try {
      const response = await fetch('https://0x0.st', {
        method: 'POST',
        body: formData
      });
      if (response.ok) {
        const text = await response.text();
        fileUrl = text.trim();
      }
    } catch (err0x0) {
      console.warn('0x0.st upload failed, attempting fallback to Catbox.moe...', err0x0.message);
    }

    // Fallback to Catbox.moe if 0x0.st failed
    if (!fileUrl) {
      const catboxForm = new FormData();
      catboxForm.append('reqtype', 'fileupload');
      catboxForm.append('fileToUpload', blob, filename);

      const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: catboxForm
      });
      if (response.ok) {
        const text = await response.text();
        fileUrl = text.trim();
      }
    }

    if (fileUrl && fileUrl.startsWith('http')) {
      console.log(`Media uploaded successfully: ${fileUrl}`);
      res.json({ url: fileUrl });
    } else {
      throw new Error('Upload APIs did not return a valid URL.');
    }

  } catch (err) {
    console.error('Media proxy upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload media to cloud hosting.' });
  }
});

// Fallback routing for SPA web loading
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================================================
// WEBSOCKET REAL-TIME SERVER
// ==========================================================================

wss.on('connection', (ws) => {
  ws.isAuthenticated = false;
  ws.username = null;

  ws.on('message', async (messageString) => {
    try {
      const data = JSON.parse(messageString);

      // --- LOGIN/AUTHENTICATION ---
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

        // Fetch history and send
        const history = await getMessagesFromDB();
        ws.send(JSON.stringify({
          type: 'history',
          messages: history
        }));
        return;
      }

      // Safeguard check
      if (!ws.isAuthenticated) {
        ws.close();
        return;
      }

      // --- TEXT & MEDIA MESSAGING ---
      if (data.type === 'message') {
        const { text, fileUrl, fileType } = data;
        const timestamp = Date.now();

        const msgObj = {
          username: ws.username,
          text,
          fileUrl,
          fileType,
          timestamp
        };

        // Insert and broadcast message
        const savedMsg = await insertMessageToDB(msgObj);
        const broadcastPayload = JSON.stringify({
          type: 'message',
          message: savedMsg
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

// Start web server listening
server.listen(PORT, () => {
  console.log(`VanishChat Server running on port ${PORT}`);
});
