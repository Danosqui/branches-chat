// REEMPLAZAR ESTA URL CON LA DE TU BACKEND DEPLOYADO
const BACKEND_URL = 'https://branches-chat-production.up.railway.app'; 
const socket = io(BACKEND_URL);

socket.on('connect', () => {
    console.log('Conexión establecida con el servidor. ID:', socket.id);
});

let currentThreadId = null;
const messagesData = {};

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
        messagesData[reply.message_id].replies.push(reply.text);
    }
    renderMainChat();
    if (currentThreadId === reply.message_id) {
        renderThread();
    }
});

function renderMainChat() {
    console.log("rendermainchat funca?")
    const container = document.getElementById('main-messages');
    container.innerHTML = '';
    
    Object.values(messagesData).forEach(msg => {
        const div = document.createElement('div');
        div.className = 'message';
        
        const textDiv = document.createElement('div');
        textDiv.textContent = msg.text;
        
        const replyBtn = document.createElement('button');
        replyBtn.className = 'reply-btn';
        const replyCount = msg.replies ? msg.replies.length : 0;
        replyBtn.textContent = replyCount > 0 ? `Ver hilo (${replyCount})` : 'Responder en hilo';
        replyBtn.onclick = () => openThread(msg.id);
        
        div.appendChild(textDiv);
        div.appendChild(replyBtn);
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function sendMainMessage() {
    console.log("intento mandar un main mes")
    const input = document.getElementById('main-input');
    const text = input.value.trim();
    if (!text) return;
    console.log("continue" + input.value.trim())
    socket.emit('new_main_message',text);
    console.log("dgdagdagda", text)
    input.value = '';
}

function openThread(id) {
    currentThreadId = id;
    document.getElementById('thread-view').style.display = 'flex';
    document.getElementById('thread-parent-text').textContent = messagesData[id].text;
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
    
    const replies = messagesData[currentThreadId].replies || [];
    replies.forEach(text => {
        const div = document.createElement('div');
        div.className = 'message thread-message';
        div.textContent = text;
        container.appendChild(div);
    });
    
    container.scrollTop = container.scrollHeight;
}

function sendThreadMessage() {
    if (!currentThreadId) return;
    const input = document.getElementById('thread-input');
    const text = input.value.trim();
    if (!text) return;

    socket.emit('new_thread_message', { message_id: currentThreadId, text });
    input.value = '';

}
