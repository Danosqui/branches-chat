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
    window.location.href = 'login.html';
}

const currentUser = auth ? auth.user : null;
const authToken = auth ? auth.token : null;

// ================= CONEXIÓN SOCKET.IO =================
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
let unreadTitleCount = 0;
let userReads = { main: 0, threads: {} };

// ================= WEB PUSH & NOTIFICACIONES =================
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function initServiceWorkerAndPush() {
    if (!('serviceWorker' in navigator)) return;

    try {
        const reg = await navigator.serviceWorker.register('sw.js');
        console.log('Service Worker registrado correctamente.');

        // Si las notificaciones están activadas en preferencias y hay permiso, asegurar suscripción
        const isNotifEnabled = localStorage.getItem('notifications_enabled') !== 'false';
        if (isNotifEnabled && Notification.permission === 'granted') {
            await subscribeUserToPush(reg);
        }
    } catch (err) {
        console.warn('Error al registrar Service Worker o Push:', err);
    }
}

async function subscribeUserToPush(existingReg) {
    if (!('PushManager' in window)) return;
    try {
        const reg = existingReg || await navigator.serviceWorker.ready;
        const keyRes = await fetch(`${BACKEND_URL}/api/push/vapid-public-key`);
        const { publicKey } = await keyRes.json();

        let subscription = await reg.pushManager.getSubscription();
        if (!subscription) {
            subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }

        await fetch(`${BACKEND_URL}/api/push/subscribe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ subscription })
        });
    } catch (err) {
        console.warn('No se pudo completar la suscripción a Web Push:', err);
    }
}

async function unsubscribeUserFromPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const subscription = await reg.pushManager.getSubscription();
        if (subscription) {
            await fetch(`${BACKEND_URL}/api/push/unsubscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            await subscription.unsubscribe();
        }
    } catch (err) {
        console.warn('Error al desuscribir de Web Push:', err);
    }
}

function updateNotificationButton() {
    const notifBtn = document.getElementById('notif-toggle-btn');
    if (!notifBtn) return;
    const isEnabled = localStorage.getItem('notifications_enabled') !== 'false';
    if (isEnabled && ('Notification' in window) && Notification.permission === 'granted') {
        notifBtn.textContent = '🔔 Notificaciones: Sí';
        notifBtn.classList.remove('muted');
        notifBtn.title = 'Clic para silenciar las notificaciones';
    } else {
        notifBtn.textContent = '🔕 Notificaciones: Silenciadas';
        notifBtn.classList.add('muted');
        notifBtn.title = 'Clic para activar las notificaciones';
    }
}

async function toggleNotifications() {
    const isCurrentlyEnabled = localStorage.getItem('notifications_enabled') !== 'false';
    const notifBtn = document.getElementById('notif-toggle-btn');

    if (isCurrentlyEnabled && Notification.permission === 'granted') {
        // Silenciar notificaciones
        localStorage.setItem('notifications_enabled', 'false');
        updateNotificationButton();
        await unsubscribeUserFromPush();
    } else {
        // Activar notificaciones
        if ('Notification' in window) {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                localStorage.setItem('notifications_enabled', 'true');
                updateNotificationButton();
                await subscribeUserToPush();
            } else {
                alert('Las notificaciones están bloqueadas en tu navegador. Podés habilitarlas haciendo clic en el candado de la barra de direcciones.');
            }
        }
    }
}

function triggerDesktopNotification(title, body) {
    const isEnabled = localStorage.getItem('notifications_enabled') !== 'false';
    if (!isEnabled) return;
    if (('Notification' in window) && Notification.permission === 'granted' && document.hidden) {
        try {
            new Notification(title, {
                body,
                icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png'
            });
        } catch (e) {
            console.log('Fallo al mostrar notificación en primer plano:', e);
        }
    }
}

// ================= GESTIÓN DE LECTURA Y TÍTULO =================
function updateTitle() {
    let totalUnread = 0;

    // 1. Mensajes principales no leídos (solo si la pestaña está en segundo plano)
    if (document.hidden) {
        const unreadMain = Object.values(messagesData).filter(m => 
            (m.id || 0) > (userReads.main || 0) && 
            m.sender_id !== currentUser?.id
        ).length;
        totalUnread += unreadMain;
    }

    // 2. Respuestas no leídas en hilos: se mantienen como no leídas hasta que se abra el hilo
    Object.values(messagesData).forEach(msg => {
        // Si este hilo está abierto y la pestaña está activa, no se cuenta como no leído
        if (currentThreadId === msg.id && !document.hidden) {
            return;
        }
        const lastReadReplyId = (userReads.threads && userReads.threads[msg.id]) || 0;
        const replies = msg.replies || [];
        const unreadInThread = replies.filter(r => 
            (r.id || 0) > lastReadReplyId && 
            r.sender_id !== currentUser?.id
        ).length;
        totalUnread += unreadInThread;
    });

    if (totalUnread > 0) {
        document.title = `(${totalUnread}) Chat con Hilos`;
    } else {
        document.title = 'Chat con Hilos';
    }
}

function markCurrentMainMessagesAsRead() {
    const ids = Object.keys(messagesData).map(Number);
    if (ids.length === 0) return;
    const maxId = Math.max(...ids);
    if (maxId > (userReads.main || 0)) {
        userReads.main = maxId;
        socket.emit('mark_read', { thread_id: 0, last_read_id: maxId });
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        markCurrentMainMessagesAsRead();
        // Si hay un hilo abierto al volver a la pestaña, marcar sus respuestas como leídas
        if (currentThreadId && messagesData[currentThreadId]) {
            const replies = messagesData[currentThreadId].replies || [];
            if (replies.length > 0) {
                const maxReplyId = Math.max(...replies.map(r => r.id || 0));
                userReads.threads[currentThreadId] = maxReplyId;
                socket.emit('mark_read', { thread_id: currentThreadId, last_read_id: maxReplyId });
                renderMainChat();
            }
        }
    }
    updateTitle();
});

// Sincronización en tiempo real desde otro dispositivo o pestaña
socket.on('sync_read', (data) => {
    if (!data) return;
    if (data.thread_id === 0) {
        userReads.main = Math.max(userReads.main || 0, data.last_read_id);
        const sep = document.getElementById('new-messages-separator');
        if (sep) sep.remove();
    } else {
        userReads.threads[data.thread_id] = Math.max(userReads.threads[data.thread_id] || 0, data.last_read_id);
        renderMainChat();
    }
    updateTitle();
});

// ================= EVENTOS DE CHAT =================
socket.on('initial_data', (payload) => {
    const messages = Array.isArray(payload) ? payload : (payload.messages || []);
    if (payload.userReads) {
        userReads = payload.userReads;
    }

    messages.forEach(msg => {
        messagesData[msg.id] = msg;
    });

    renderMainChat();

    if (!document.hidden) {
        setTimeout(markCurrentMainMessagesAsRead, 1000);
    }
    updateTitle();
});

socket.on('receive_main_message', (msg) => {
    messagesData[msg.id] = msg;
    renderMainChat();

    if (document.hidden) {
        if (msg.sender_id !== currentUser?.id) {
            triggerDesktopNotification(`Nuevo mensaje de ${msg.sender}`, msg.text);
        }
    } else {
        markCurrentMainMessagesAsRead();
    }
    updateTitle();
});

socket.on('receive_thread_message', (reply) => {
    if (messagesData[reply.message_id]) {
        if (!messagesData[reply.message_id].replies) {
            messagesData[reply.message_id].replies = [];
        }
        messagesData[reply.message_id].replies.push({
            id: reply.id,
            sender_id: reply.sender_id,
            sender: reply.sender || 'Anónimo',
            text: reply.text
        });
    }

    renderMainChat();

    if (currentThreadId === reply.message_id) {
        renderThread();
        if (!document.hidden) {
            userReads.threads[reply.message_id] = reply.id;
            socket.emit('mark_read', { thread_id: reply.message_id, last_read_id: reply.id });
        }
    } else {
        if (document.hidden && reply.sender_id !== currentUser?.id) {
            triggerDesktopNotification(`Respuesta en hilo de ${reply.sender}`, reply.text);
        }
    }
    updateTitle();
});

// ================= RENDERIZADO =================
function renderMainChat() {
    const container = document.getElementById('main-messages');
    if (!container) return;
    container.innerHTML = '';
    
    let insertedSeparator = false;

    Object.values(messagesData).forEach(msg => {
        // Indicador de mensajes no leídos desde la última visita
        if (!insertedSeparator && userReads.main > 0 && msg.id > userReads.main && msg.sender_id !== currentUser?.id) {
            const sep = document.createElement('div');
            sep.className = 'unread-separator';
            sep.id = 'new-messages-separator';
            sep.innerHTML = '<span>── Mensajes nuevos desde tu última visita ──</span>';
            container.appendChild(sep);
            insertedSeparator = true;
        }

        const div = document.createElement('div');
        div.className = 'message';
        
        const isMe = currentUser && ((msg.sender_id && msg.sender_id === currentUser.id) || msg.sender === currentUser.username);
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
        
        const replies = msg.replies || [];
        const replyCount = replies.length;
        const lastReadReplyId = userReads.threads ? (userReads.threads[msg.id] || 0) : 0;
        const unreadReplies = replies.filter(r => (r.id || 0) > lastReadReplyId).length;

        if (replyCount > 0) {
            if (unreadReplies > 0) {
                replyBtn.innerHTML = `Ver hilo (${replyCount}) <span class="unread-badge">🔴 ${unreadReplies} nuevo${unreadReplies > 1 ? 's' : ''}</span>`;
            } else {
                replyBtn.textContent = `Ver hilo (${replyCount})`;
            }
        } else {
            replyBtn.textContent = 'Responder en hilo';
        }

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

        // Marcar todas las respuestas de este hilo como leídas
        const replies = msg.replies || [];
        if (replies.length > 0) {
            const maxReplyId = Math.max(...replies.map(r => r.id || 0));
            if (maxReplyId > (userReads.threads[id] || 0)) {
                userReads.threads[id] = maxReplyId;
                socket.emit('mark_read', { thread_id: id, last_read_id: maxReplyId });
            }
        }
        renderThread();
        renderMainChat(); // Refresca el botón en el chat principal para apagar el badge rojo
        updateTitle();    // Actualiza el título para quitar el (1) del hilo que se acaba de abrir
    }
}

function closeThread() {
    currentThreadId = null;
    document.getElementById('thread-view').style.display = 'none';
    updateTitle();
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

// ================= INICIALIZACIÓN EN DOM =================
document.addEventListener('DOMContentLoaded', () => {
    const userDisplay = document.getElementById('current-user-display');
    if (userDisplay && currentUser) {
        userDisplay.textContent = currentUser.username;
    }

    updateNotificationButton();
    initServiceWorkerAndPush();
});
