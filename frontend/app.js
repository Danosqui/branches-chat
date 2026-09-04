// ================= GESTIÓN DE SESIÓN =================
function getStoredAuth() {
    const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    const userStr = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
    if (!token || !userStr) return null;
    try {
        return { token, user: JSON.parse(userStr) };
    } catch (e) {
        return null;
    }
}

const auth = getStoredAuth();
if (!auth) {
    // Si no hay sesión activa, redirigir inmediatamente a login.html
    window.location.href = 'login.html';
}

const currentUser = auth ? auth.user : null;
const authToken = auth ? auth.token : null;

// Mostrar el usuario activo en la barra superior
document.addEventListener('DOMContentLoaded', () => {
    const userDisplay = document.getElementById('current-user-display');
    if (userDisplay && currentUser) {
        userDisplay.textContent = currentUser.username;
    }
});

function logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('auth_token');
    sessionStorage.removeItem('currentUser');
    if (typeof socket !== 'undefined' && socket) {
        socket.disconnect();
    }
    window.location.href = 'login.html';
}

// ================= CONEXIÓN SOCKET.IO =================
// URL del Backend independiente (Railway en producción, localhost:3000 en desarrollo)
const BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://branches-chat-production.up.railway.app';

const socket = io(BACKEND_URL, {
    auth: {
        token: authToken
    }
});

socket.on('connect', () => {
    console.log('Conexión establecida con el servidor. Socket ID:', socket.id);
});

socket.on('connect_error', (err) => {
    console.warn('Error en la conexión con el servidor:', err.message);
});

let currentThreadId = null;
const messagesData = {};

// ================= EVENTOS DE CHAT =================
socket.on('initial_data', (data) => {
    data.forEach(msg => {
        messagesData[msg.id] = msg;
    });
    renderMainChat();
});

socket.on('receive_main_message', (msg) => {
    messagesData[msg.id] = msg;
    renderMainChat();
});

socket.on('receive_thread_message', (reply) => {
    if (messagesData[reply.message_id]) {
        if (!messagesData[reply.message_id].replies) {
            messagesData[reply.message_id].replies = [];
        }
        messagesData[reply.message_id].replies.push({
            id: reply.id,
            sender: reply.sender || 'Anónimo',
            text: reply.text
        });
    }
    renderMainChat();
    if (currentThreadId === reply.message_id) {
        renderThread();
    }
});

// ================= RENDERIZADO =================
function renderMainChat() {
    const container = document.getElementById('main-messages');
    if (!container) return;
    container.innerHTML = '';
    
    Object.values(messagesData).forEach(msg => {
        const div = document.createElement('div');
        div.className = 'message';
        
        const isMe = currentUser && msg.sender === currentUser.username;
        if (isMe) {
            div.classList.add('my-message');
        }

        const senderDiv = document.createElement('div');
        senderDiv.className = 'message-sender';
        senderDiv.textContent = isMe ? `${msg.sender} (Vos)` : (msg.sender || 'Anónimo');

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = msg.text;
        
        const replyBtn = document.createElement('button');
        replyBtn.className = 'reply-btn';
        const replyCount = msg.replies ? msg.replies.length : 0;
        replyBtn.textContent = replyCount > 0 ? `Ver hilo (${replyCount})` : 'Responder en hilo';
        replyBtn.onclick = () => openThread(msg.id);
        
        div.appendChild(senderDiv);
        div.appendChild(textDiv);
        div.appendChild(replyBtn);
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function sendMainMessage() {
    const input = document.getElementById('main-input');
    const text = input.value.trim();
    if (!text) return;

    socket.emit('new_main_message', { 
        sender_id: currentUser ? currentUser.id : null,
        sender: currentUser ? currentUser.username : 'Anónimo', 
        text 
    });
    input.value = '';
}

function openThread(id) {
    currentThreadId = id;
    const threadView = document.getElementById('thread-view');
    threadView.style.display = 'flex';

    const msg = messagesData[id];
    const parentSender = document.getElementById('thread-parent-sender');
    const parentText = document.getElementById('thread-parent-text');
    
    if (msg) {
        parentSender.textContent = msg.sender || 'Anónimo';
        parentText.textContent = msg.text;
    }
    renderThread();
}

function closeThread() {
    currentThreadId = null;
    document.getElementById('thread-view').style.display = 'none';
}

function renderThread() {
    if (!currentThreadId) return;
    
    const container = document.getElementById('thread-messages');
    container.innerHTML = '';
    
    const replies = messagesData[currentThreadId]?.replies || [];
    replies.forEach(reply => {
        const div = document.createElement('div');
        div.className = 'message thread-message';

        const sender = typeof reply === 'object' ? (reply.sender || 'Anónimo') : 'Anónimo';
        const senderId = typeof reply === 'object' ? reply.sender_id : null;
        const text = typeof reply === 'object' ? reply.text : reply;

        const isMe = currentUser && ((senderId && senderId === currentUser.id) || sender === currentUser.username);
        if (isMe) {
            div.classList.add('my-message');
        }

        const senderDiv = document.createElement('div');
        senderDiv.className = 'message-sender';
        senderDiv.textContent = isMe ? `${sender} (Vos)` : sender;

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;

        div.appendChild(senderDiv);
        div.appendChild(textDiv);
        container.appendChild(div);
    });
    
    container.scrollTop = container.scrollHeight;
}

function sendThreadMessage() {
    if (!currentThreadId) return;
    const input = document.getElementById('thread-input');
    const text = input.value.trim();
    if (!text) return;

    socket.emit('new_thread_message', { 
        message_id: currentThreadId, 
        sender_id: currentUser ? currentUser.id : null,
        sender: currentUser ? currentUser.username : 'Anónimo', 
        text 
    });
    input.value = '';
}
