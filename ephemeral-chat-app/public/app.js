// App State
const state = {
  username: null,
  socket: null,
  selectedImageBase64: null,
  reconnectTimer: null
};

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// DOM Elements
const elements = {
  loginOverlay: document.getElementById('loginOverlay'),
  loginForm: document.getElementById('loginForm'),
  nicknameInput: document.getElementById('nicknameInput'),
  
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
  
  lightboxModal: document.getElementById('lightboxModal'),
  lightboxImage: document.getElementById('lightboxImage'),
  lightboxClose: document.getElementById('lightboxClose')
};

// ==========================================================================
// WEBSOCKET CONNECTION MANAGER
// ==========================================================================

function connectWebSocket() {
  if (state.socket) {
    state.socket.close();
  }

  // Resolve WS protocol (ws:// locally, wss:// when deployed securely)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  updateConnectionStatus('connecting');

  state.socket = new WebSocket(wsUrl);

  state.socket.onopen = () => {
    updateConnectionStatus('connected');
    console.log('Connected to chat server.');
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  state.socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'history') {
        // Render full chat history
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
        // Remove expired messages from the screen instantly
        const bubbles = elements.messagesContainer.querySelectorAll('.message-wrapper');
        bubbles.forEach(wrapper => {
          const ts = parseInt(wrapper.getAttribute('data-timestamp'));
          if (ts < data.cutoff) {
            wrapper.remove();
          }
        });
        
        // If zero messages left, show empty state
        const count = elements.messagesContainer.querySelectorAll('.message-wrapper').length;
        if (count === 0) {
          elements.emptyState.style.display = 'flex';
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  state.socket.onclose = () => {
    updateConnectionStatus('disconnected');
    console.log('Lost connection. Retrying in 3 seconds...');
    
    // Auto-reconnect
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
// RENDER MESSAGES IN UI
// ==========================================================================

// Format expiration countdown string
function getCountdownText(timestamp) {
  const elapsed = Date.now() - timestamp;
  const remaining = EXPIRY_MS - elapsed;
  
  if (remaining <= 0) return 'Expired';
  
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  
  if (days > 0) {
    return `${days}d ${hours}h left`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m left`;
  } else {
    return `${minutes}m left`;
  }
}

// Format message standard time
function formatMsgTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessageBubbleToDOM(msg) {
  const isSelf = msg.username === state.username;
  const countdown = getCountdownText(msg.timestamp);
  const elapsedRatio = Math.min(100, Math.max(0, ((Date.now() - msg.timestamp) / EXPIRY_MS) * 100));
  const remainingTime = EXPIRY_MS - (Date.now() - msg.timestamp);
  const isUrgent = remainingTime < 4 * 60 * 60 * 1000;
  
  // Skip if already in DOM
  if (elements.messagesContainer.querySelector(`.message-wrapper[data-id="${msg.id}"]`)) {
    return;
  }

  // Remove empty state
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
  
  // Scroll to bottom
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

// Escaping helper for security (avoid XSS)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

// ==========================================================================
// IMAGE COMPRESSION & ATTACHMENT HANDLERS
// ==========================================================================

function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      // Compress heavily for real-time socket broadcasting
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
// LIGHTBOX FULLSCREEN PREVIEWS
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
// FORM SUBMITS & NICKNAME INITIALIZATION
// ==========================================================================

function handleNicknameSubmit(e) {
  e.preventDefault();
  const name = elements.nicknameInput.value.trim();
  if (!name) return;

  state.username = name;
  sessionStorage.setItem('vanishchat_user', name);
  
  elements.loginOverlay.classList.add('hidden');
  
  // Start socket connection
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
      username: state.username,
      text: text,
      image: image
    });
    
    state.socket.send(payload);
  } else {
    alert("Cannot send message. Server is disconnected.");
  }

  // Reset form
  elements.messageInput.value = '';
  clearImageAttachment();
}

// Bind Events
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
  
  document.onkeydown = (e) => {
    if (e.key === 'Escape') closeLightbox();
  };
}

// App Setup
function setupApp() {
  bindEvents();
  
  // Check if user is already logged in
  const savedUser = sessionStorage.getItem('vanishchat_user');
  if (savedUser) {
    state.username = savedUser;
    elements.loginOverlay.classList.add('hidden');
    connectWebSocket();
  }

  // Live countdown refresher (runs every 10 seconds)
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
