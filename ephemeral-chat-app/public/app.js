// App State
const state = {
  username: null,
  socket: null,
  selectedImageBase64: null,
  reconnectTimer: null,
  
  // Voice call properties (WebRTC Mesh)
  isInCall: false,
  localStream: null,
  peerConnections: {}, // username -> RTCPeerConnection
  voiceUsersList: [],
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// DOM Elements
const elements = {
  loginOverlay: document.getElementById('loginOverlay'),
  loginForm: document.getElementById('loginForm'),
  nicknameInput: document.getElementById('nicknameInput'),
  passwordInput: document.getElementById('passwordInput'),
  
  messagesContainer: document.getElementById('messagesContainer'),
  composerForm: document.getElementById('composerForm'),
  messageInput: document.getElementById('messageInput'),
  fileInput: document.getElementById('fileInput'),
  attachBtn: document.getElementById('attachBtn'),
  attachmentPreviewBar: document.getElementById('attachmentPreviewBar'),
  imagePreview: document.getElementById('imagePreview'),
  removePreviewBtn: document.getElementById('removePreviewBtn'),
  emptyState: document.getElementById('emptyState'),
  
  connBadge: document.getElementById('connBadge'),
  connText: document.getElementById('connText'),
  
  // Voice Controls
  voiceBtn: document.getElementById('voiceBtn'),
  voiceBtnText: document.getElementById('voiceBtnText'),
  voiceStatusText: document.getElementById('voiceStatusText'),
  activeSpeakers: document.getElementById('activeSpeakers'),
  
  lightboxModal: document.getElementById('lightboxModal'),
  lightboxImage: document.getElementById('lightboxImage'),
  lightboxClose: document.getElementById('lightboxClose')
};

// ==========================================================================
// WEBSOCKET CONNECTION & PASSWORD AUTHENTICATION
// ==========================================================================

function connectWebSocket() {
  if (state.socket) {
    state.socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws';
  const wsUrl = `${protocol}//${window.location.host}`;

  updateConnectionStatus('connecting');

  state.socket = new WebSocket(wsUrl);

  state.socket.onopen = () => {
    updateConnectionStatus('connected');
    console.log('Socket opened. Sending authentication...');
    
    // Send join payload with username and password
    const savedPassword = sessionStorage.getItem('vanishchat_password');
    state.socket.send(JSON.stringify({
      type: 'join',
      username: state.username,
      password: savedPassword
    }));

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  state.socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'auth-error') {
        alert(data.message);
        // Clear saved session states on password error
        sessionStorage.removeItem('vanishchat_user');
        sessionStorage.removeItem('vanishchat_password');
        window.location.reload();
        return;
      }

      if (data.type === 'history') {
        // Clear message panel
        const wrappers = elements.messagesContainer.querySelectorAll('.message-wrapper');
        wrappers.forEach(el => el.remove());
        
        if (data.messages.length === 0) {
          elements.emptyState.style.display = 'flex';
        } else {
          elements.emptyState.style.display = 'none';
          data.messages.forEach(msg => appendMessageBubbleToDOM(msg));
        }
      } 
      
      else if (data.type === 'message') {
        appendMessageBubbleToDOM(data.message);
      } 
      
      else if (data.type === 'prune') {
        const bubbles = elements.messagesContainer.querySelectorAll('.message-wrapper');
        bubbles.forEach(wrapper => {
          const ts = parseInt(wrapper.getAttribute('data-timestamp'));
          if (ts < data.cutoff) {
            wrapper.remove();
          }
        });
        
        const count = elements.messagesContainer.querySelectorAll('.message-wrapper').length;
        if (count === 0) {
          elements.emptyState.style.display = 'flex';
        }
      }

      // --- VOICE CALL COORDINATION EVENT ---
      else if (data.type === 'voice-users-list') {
        state.voiceUsersList = data.users.filter(u => u !== state.username);
        renderSpeakersList(data.users);
        
        // If we are in voice, initiate P2P connections to any new participants who joined
        if (state.isInCall) {
          state.voiceUsersList.forEach(user => {
            if (!state.peerConnections[user]) {
              initiatePeerConnection(user, true); // We initiate offer to new users
            }
          });
        }
      }

      // --- WEBRTC SIGNAL RELAY ---
      else if (data.type === 'signal') {
        const { from, signal } = data;
        
        // We only handle signals if we are currently inside the voice call
        if (state.isInCall) {
          handleIncomingSignal(from, signal);
        }
      }

    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  state.socket.onclose = () => {
    updateConnectionStatus('disconnected');
    console.log('Lost connection. Retrying in 3 seconds...');
    
    // Disconnect voice calls if WebSocket closes
    if (state.isInCall) {
      leaveVoiceCall();
    }
    
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  };

  state.socket.onerror = (err) => {
    console.error('WebSocket error:', err);
    state.socket.close();
  };
}

function updateConnectionStatus(status) {
  if (status === 'connected') {
    elements.connBadge.className = 'status-badge status-connected';
    elements.connText.textContent = 'Connected';
  } else if (status === 'connecting') {
    elements.connBadge.className = 'status-badge status-disconnected';
    elements.connText.textContent = 'Connecting...';
  } else {
    elements.connBadge.className = 'status-badge status-disconnected';
    elements.connText.textContent = 'Offline (Reconnecting)';
  }
}

// ==========================================================================
// DISCORD-LIKE VOICE CALL ENGINE (WebRTC Mesh)
// ==========================================================================

async function toggleVoiceCall() {
  if (state.isInCall) {
    leaveVoiceCall();
  } else {
    await joinVoiceCall();
  }
}

async function joinVoiceCall() {
  if (state.socket.readyState !== WebSocket.OPEN) {
    alert("Cannot join voice call: Server disconnected.");
    return;
  }

  try {
    // Request microphone access
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.isInCall = true;
    
    // Update Button UI
    elements.voiceBtn.className = 'voice-btn voice-btn-connected';
    elements.voiceBtnText.textContent = 'Leave Call';
    elements.voiceStatusText.textContent = 'Connected to Voice';

    // Notify server we joined the call
    state.socket.send(JSON.stringify({
      type: 'voice-state',
      joined: true
    }));

    // Initiate P2P connection to everyone currently in the call
    state.voiceUsersList.forEach(user => {
      initiatePeerConnection(user, true); // We are the initiator
    });

    console.log("Joined voice call successfully.");
  } catch (error) {
    console.error("Microphone access denied:", error);
    alert("Microphone permission is required to join the voice call.");
  }
}

function leaveVoiceCall() {
  state.isInCall = false;

  // Stop local microphone tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }

  // Close all peer connections
  Object.keys(state.peerConnections).forEach(username => {
    closePeerConnection(username);
  });

  // Notify server we left
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({
      type: 'voice-state',
      joined: false
    }));
  }

  // Update Button UI
  elements.voiceBtn.className = 'voice-btn voice-btn-disconnected';
  elements.voiceBtnText.textContent = 'Join Call';
  elements.voiceStatusText.textContent = 'Voice call inactive';
  
  console.log("Left voice call.");
}

// Initiate RTCPeerConnection
function initiatePeerConnection(targetUsername, isInitiator) {
  if (state.peerConnections[targetUsername]) {
    closePeerConnection(targetUsername);
  }

  console.log(`Setting up WebRTC connection to: ${targetUsername} (Initiator: ${isInitiator})`);
  const pc = new RTCPeerConnection(state.rtcConfig);
  state.peerConnections[targetUsername] = pc;

  // ICE candidates callback
  pc.onicecandidate = (event) => {
    if (event.candidate && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({
        type: 'signal',
        to: targetUsername,
        signal: { candidate: event.candidate }
      }));
    }
  };

  // Remote stream track listener
  pc.ontrack = (event) => {
    console.log(`Received remote audio stream track from ${targetUsername}`);
    
    // Check if audio element already exists for this peer
    let audio = document.getElementById(`audio-${targetUsername}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${targetUsername}`;
      audio.autoplay = true;
      audio.style.display = 'none'; // Hidden audio elements
      document.body.appendChild(audio);
    }
    
    audio.srcObject = event.streams[0];
  };

  // Attach local mic tracks to peer connection
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  // Handle negotiation for initiator
  if (isInitiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        state.socket.send(JSON.stringify({
          type: 'signal',
          to: targetUsername,
          signal: { sdp: pc.localDescription }
        }));
      })
      .catch(err => console.error("WebRTC offer generation error:", err));
  }
}

// Process WebRTC handshakes
function handleIncomingSignal(from, signal) {
  let pc = state.peerConnections[from];
  
  if (!pc) {
    // We create a non-initiator connection if it doesn't exist yet
    initiatePeerConnection(from, false);
    pc = state.peerConnections[from];
  }

  if (signal.sdp) {
    pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      .then(() => {
        // If it's an offer, we must generate an answer
        if (pc.remoteDescription.type === 'offer') {
          pc.createAnswer()
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
              state.socket.send(JSON.stringify({
                type: 'signal',
                to: from,
                signal: { sdp: pc.localDescription }
              }));
            });
        }
      })
      .catch(err => console.error("WebRTC SDP handshaking error:", err));
  } 
  
  else if (signal.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
      .catch(err => console.error("WebRTC ICE addition error:", err));
  }
}

function closePeerConnection(username) {
  const pc = state.peerConnections[username];
  if (pc) {
    pc.close();
    delete state.peerConnections[username];
  }

  // Cleanup remote audio node
  const audio = document.getElementById(`audio-${username}`);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
  }
}

// Update UI panel listing who is currently inside the voice call
function renderSpeakersList(users) {
  elements.activeSpeakers.innerHTML = '';
  
  if (users.length === 0) {
    const span = document.createElement('span');
    span.style.fontSize = '12px';
    span.style.color = 'var(--text-muted)';
    span.textContent = 'No speakers';
    elements.activeSpeakers.appendChild(span);
    return;
  }

  users.forEach(username => {
    const tag = document.createElement('span');
    tag.className = 'speaker-tag';
    
    // Add pulsing indicator dot
    const pulseDot = document.createElement('span');
    pulseDot.className = 'speaker-indicator-pulse';
    
    tag.appendChild(pulseDot);
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = username === state.username ? `${username} (You)` : username;
    tag.appendChild(nameSpan);
    
    elements.activeSpeakers.appendChild(tag);
  });
}

// ==========================================================================
// RENDER MESSAGE TIMELINE
// ==========================================================================

function appendMessageBubbleToDOM(msg) {
  const isSelf = msg.username === state.username;
  const countdown = getCountdownText(msg.timestamp);
  const elapsedRatio = Math.min(100, Math.max(0, ((Date.now() - msg.timestamp) / EXPIRY_MS) * 100));
  const remainingTime = EXPIRY_MS - (Date.now() - msg.timestamp);
  const isUrgent = remainingTime < 4 * 60 * 60 * 1000;
  
  // Skip if already drawn
  if (elements.messagesContainer.querySelector(`.message-wrapper[data-id="${msg.id}"]`)) {
    return;
  }

  elements.emptyState.style.display = 'none';

  const el = document.createElement('article');
  el.className = `message-wrapper ${isSelf ? 'message-self' : 'message-peer'}`;
  el.dataset.id = msg.id;
  el.setAttribute('data-timestamp', msg.timestamp);
  
  let attachmentHTML = '';
  if (msg.image) {
    attachmentHTML = `
      <div class="message-attachment" onclick="openLightbox('${msg.image}')">
        <img src="${msg.image}" alt="Attached media">
      </div>
    `;
  }
  
  el.innerHTML = `
    <div class="message-info">
      <span class="message-sender">${escapeHtml(msg.username)}</span>
      <span class="message-time">${formatMsgTime(msg.timestamp)}</span>
      <span class="message-expiry ${isUrgent ? 'expiry-urgent' : ''}">
        <i data-lucide="hourglass"></i>
        <span class="expiry-time-text">${countdown}</span>
      </span>
    </div>
    <div class="message-bubble">
      ${msg.text ? `<div>${escapeHtml(msg.text)}</div>` : ''}
      ${attachmentHTML}
      <div class="decay-indicator" style="width: ${100 - elapsedRatio}%"></div>
    </div>
  `;
  
  elements.messagesContainer.appendChild(el);
  lucide.createIcons();
  
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// Escaping helper for security (avoid XSS)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

// ==========================================================================
// IMAGE COMPRESSION & SELECTORS
// ==========================================================================

function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      const maxDim = 500;
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      state.selectedImageBase64 = canvas.toDataURL('image/jpeg', 0.55);
      
      elements.imagePreview.src = state.selectedImageBase64;
      elements.attachmentPreviewBar.style.display = 'flex';
      elements.messageInput.placeholder = 'Add a caption... (optional)';
      elements.messageInput.required = false;
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function clearImageAttachment() {
  state.selectedImageBase64 = null;
  elements.fileInput.value = '';
  elements.attachmentPreviewBar.style.display = 'none';
  elements.imagePreview.src = '';
  elements.messageInput.placeholder = 'Type a secure message...';
  elements.messageInput.required = true;
}

// ==========================================================================
// LIGHTBOX MODAL PREVIEWS
// ==========================================================================

function openLightbox(imgSrc) {
  elements.lightboxImage.src = imgSrc;
  elements.lightboxModal.classList.add('active');
  elements.lightboxModal.setAttribute('aria-hidden', 'false');
}

function closeLightbox() {
  elements.lightboxModal.classList.remove('active');
  elements.lightboxModal.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    elements.lightboxImage.src = '';
  }, 250);
}

window.openLightbox = openLightbox;

// ==========================================================================
// FORMS SUBMITS & NICKNAME AUTHENTICATION
// ==========================================================================

function handleNicknameSubmit(e) {
  e.preventDefault();
  const nickname = elements.nicknameInput.value.trim();
  const password = elements.passwordInput.value.trim();
  
  if (!nickname || !password) return;

  state.username = nickname;
  sessionStorage.setItem('vanishchat_user', nickname);
  sessionStorage.setItem('vanishchat_password', password);
  
  elements.loginOverlay.classList.add('hidden');
  
  // Connect socket and login
  connectWebSocket();
}

function handleSendMessage(e) {
  e.preventDefault();
  
  const text = elements.messageInput.value.trim();
  const image = state.selectedImageBase64;
  
  if (!text && !image) return;

  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({
      type: 'message',
      text: text,
      image: image
    });
    
    state.socket.send(payload);
  } else {
    alert("Cannot send message. Server is disconnected.");
  }

  // Reset composer
  elements.messageInput.value = '';
  clearImageAttachment();
}

// Bind events
function bindEvents() {
  elements.loginForm.onsubmit = handleNicknameSubmit;
  elements.composerForm.onsubmit = handleSendMessage;
  
  elements.attachBtn.onclick = () => elements.fileInput.click();
  elements.fileInput.onchange = handleImageSelect;
  elements.removePreviewBtn.onclick = clearImageAttachment;

  elements.lightboxClose.onclick = closeLightbox;
  elements.lightboxModal.onclick = (e) => {
    if (e.target === elements.lightboxModal) closeLightbox();
  };
  
  // Call trigger button click binding
  elements.voiceBtn.onclick = toggleVoiceCall;

  document.onkeydown = (e) => {
    if (e.key === 'Escape') closeLightbox();
  };
}

// Initialize Application
function setupApp() {
  bindEvents();
  
  const savedUser = sessionStorage.getItem('vanishchat_user');
  const savedPassword = sessionStorage.getItem('vanishchat_password');
  
  if (savedUser && savedPassword) {
    state.username = savedUser;
    elements.loginOverlay.classList.add('hidden');
    connectWebSocket();
  }

  // Countdown refresher (runs every 10 seconds)
  setInterval(() => {
    const bubbles = elements.messagesContainer.querySelectorAll('.message-wrapper');
    bubbles.forEach(wrapper => {
      const tsAttr = wrapper.getAttribute('data-timestamp');
      if (tsAttr) {
        const timestampVal = parseInt(tsAttr);
        const countdown = getCountdownText(timestampVal);
        const elapsedRatio = Math.min(100, Math.max(0, ((Date.now() - timestampVal) / EXPIRY_MS) * 100));
        
        const countSpan = wrapper.querySelector('.expiry-time-text');
        const decayBar = wrapper.querySelector('.decay-indicator');
        const expiryBadge = wrapper.querySelector('.message-expiry');
        const remainingTime = EXPIRY_MS - (Date.now() - timestampVal);
        
        if (countSpan) countSpan.textContent = countdown;
        if (decayBar) decayBar.style.width = `${100 - elapsedRatio}%`;
        if (remainingTime < 4 * 60 * 60 * 1000 && expiryBadge) {
          expiryBadge.classList.add('expiry-urgent');
        }
      }
    });
  }, 10000);
}

window.addEventListener('DOMContentLoaded', setupApp);
