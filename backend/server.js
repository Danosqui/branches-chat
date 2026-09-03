require("dotenv").config()
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

io.on('connection', async (socket) => {
    console.log('Usuario conectado:', socket.id);

    try {
        const msgsRes = await pool.query('SELECT * FROM messages ORDER BY id ASC');
        const repliesRes = await pool.query('SELECT * FROM replies ORDER BY id ASC');
        const data = msgsRes.rows.map(msg => {
            return {
                id: msg.id,
                text: msg.text,
                replies: repliesRes.rows.filter(r => r.message_id === msg.id).map(r => r.text)
            };
        });
        socket.emit('initial_data', data);
    } catch (err) {
        console.error('Error al cargar datos', err);
    }

    socket.onAny((eventName, ...args) => {
        console.log(` gugugaga [Socket ${socket.id}] Evento recibido: "${eventName}"`, args);
    });

    socket.on('new_main_message', async (msgData) => {
        console.log(msgData)
        console.log("wacho")
        try {
            const res = await pool.query('INSERT INTO messages (text) VALUES ($1) RETURNING *', [msgData]);
            const newMsg = { id: res.rows[0].id, text: res.rows[0].text, replies: [] };
            io.emit('receive_main_message', newMsg);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('new_thread_message', async (replyData) => {
        try {
            await pool.query('INSERT INTO replies (message_id, text) VALUES ($1, $2)', [replyData.message_id, replyData.text]);
            io.emit('receive_thread_message', { message_id: replyData.message_id, text: replyData.text });
        } catch (err) {
            console.error(err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
});
