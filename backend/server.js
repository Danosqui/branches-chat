require("dotenv").config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

const JWT_SECRET = process.env.JWT_SECRET || 'branches_chat_super_secret_key_2026';

// Configuración de Web Push (VAPID)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BIbCEyJdGemEA3lFGL084SJNG_rRKojC1PBuFlD2ML_DoXt1cNkV9dUq1jvNYuVBwneKEYfVxuew5xS9eRFYWiU';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'Ws--J3j0t4Mm8vw-lOYhGG3ZU6hGE5mWBLbI0RIG7aQ';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@branches-chat.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// Inicialización segura de tablas en la base de datos
async function initDb() {
    if (!process.env.DATABASE_URL) {
        console.warn('ADVERTENCIA: DATABASE_URL no está definida. Configura la base de datos en el archivo .env.');
        return;
    }
    try {
        // Tabla de usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabla de mensajes principales
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id),
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabla de respuestas en hilos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS replies (
                id SERIAL PRIMARY KEY,
                message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
                sender_id INTEGER REFERENCES users(id),
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Asegurar que la columna sender_id exista en replies
        await pool.query(`
            ALTER TABLE replies ADD COLUMN IF NOT EXISTS sender_id INTEGER REFERENCES users(id);
        `);

        // Tabla de punteros de lectura de mensajes (sincronización multidispositivo)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_reads (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                thread_id INTEGER DEFAULT 0,
                last_read_id INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, thread_id)
            );
        `);

        // Tabla de suscripciones a notificaciones Web Push (notificaciones con app cerrada)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Base de datos inicializada correctamente (tablas users, messages, replies, user_reads y push_subscriptions listas).');
    } catch (err) {
        console.error('Error al inicializar las tablas de la base de datos:', err);
    }
}

initDb();

// Middleware para verificar JWT en rutas HTTP protegidas
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

// ================= RUTAS DE AUTENTICACIÓN =================

// Registro de usuarios
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'El usuario y la contraseña son requeridos.' });
        }

        const trimmedUser = username.trim();
        if (trimmedUser.length < 3) {
            return res.status(400).json({ error: 'El nombre de usuario debe tener al menos 3 caracteres.' });
        }

        if (password.length < 4) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
        }

        // Verificar si el usuario ya existe
        const userCheck = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
            [trimmedUser]
        );
        if (userCheck.rows.length > 0) {
            return res.status(409).json({ error: 'El nombre de usuario ya está registrado.' });
        }

        // Hashear la contraseña con bcrypt
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        // Guardar nuevo usuario
        const insertRes = await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [trimmedUser, password_hash]
        );
        const newUser = insertRes.rows[0];

        // Crear token de sesión (7 días para registro)
        const token = jwt.sign(
            { id: newUser.id, username: newUser.username },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({
            success: true,
            message: 'Usuario creado exitosamente.',
            token,
            user: { id: newUser.id, username: newUser.username }
        });
    } catch (err) {
        console.error('Error al registrar usuario:', err);
        res.status(500).json({ error: 'Error del servidor al registrar usuario.' });
    }
});

// Inicio de sesión
app.post('/api/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'El usuario y la contraseña son requeridos.' });
        }

        const trimmedUser = username.trim();
        const userRes = await pool.query(
            'SELECT id, username, password_hash FROM users WHERE LOWER(username) = LOWER($1)',
            [trimmedUser]
        );

        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        const user = userRes.rows[0];

        // Comparar el hash con la contraseña provista
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
        }

        // Si eligió "Remember me", la sesión dura 30 días, si no dura 1 día
        const expiresIn = rememberMe ? '30d' : '1d';
        const token = jwt.sign(
            { id: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn }
        );

        res.json({
            success: true,
            message: 'Inicio de sesión exitoso.',
            token,
            user: { id: user.id, username: user.username }
        });
    } catch (err) {
        console.error('Error al iniciar sesión:', err);
        res.status(500).json({ error: 'Error del servidor al iniciar sesión.' });
    }
});

// Verificación de sesión activa
app.get('/api/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// ================= RUTAS DE WEB PUSH =================

// Obtener clave pública VAPID para suscripción en el navegador
app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Guardar suscripción Push
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ error: 'Suscripción inválida' });
        }
        await pool.query(`
            INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (endpoint) 
            DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
        `, [req.user.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]);

        res.status(201).json({ success: true, message: 'Suscripción push guardada.' });
    } catch (err) {
        console.error('Error al guardar suscripción push:', err);
        res.status(500).json({ error: 'Error al registrar suscripción push.' });
    }
});

// Eliminar suscripción Push (cuando el usuario silencia)
app.post('/api/push/unsubscribe', authenticateToken, async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (endpoint) {
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        }
        res.json({ success: true, message: 'Suscripción push eliminada.' });
    } catch (err) {
        console.error('Error al desuscribir push:', err);
        res.status(500).json({ error: 'Error al desuscribir push.' });
    }
});

// Función para enviar notificaciones Push a los demás usuarios
async function sendPushNotificationToOthers(senderUserId, title, body, extraData = {}) {
    try {
        const subsRes = await pool.query(
            'SELECT * FROM push_subscriptions WHERE user_id IS NULL OR user_id != $1',
            [senderUserId || 0]
        );

        if (subsRes.rows.length === 0) return;

        const payload = JSON.stringify({
            title,
            body,
            url: '/',
            ...extraData
        });

        const promises = subsRes.rows.map(sub => {
            const pushConfig = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            };
            return webpush.sendNotification(pushConfig, payload).catch(async (err) => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
                }
            });
        });

        await Promise.allSettled(promises);
    } catch (err) {
        console.error('Error enviando push notifications:', err);
    }
}

// ================= SOCKET.IO =================

// Middleware de autenticación opcional por socket
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.user = decoded;
        } catch (err) {
            console.log(`[Socket ${socket.id}] Token inválido o expirado.`);
        }
    }
    next();
});

io.on('connection', async (socket) => {
    const currentUsername = socket.user ? socket.user.username : 'Anónimo';
    console.log(`Usuario conectado: ${socket.id} (${currentUsername})`);

    // Unir el socket a una sala privada del usuario para sincronización multidispositivo
    if (socket.user && socket.user.id) {
        socket.join(`user_${socket.user.id}`);
    }

    try {
        // Cargar mensajes con JOIN a users para obtener el nombre de usuario
        const msgsRes = await pool.query(`
            SELECT m.id, m.sender_id, COALESCE(u.username, 'Anónimo') AS sender, m.text 
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            ORDER BY m.id ASC
        `);
        const repliesRes = await pool.query(`
            SELECT r.id, r.message_id, r.sender_id, COALESCE(u.username, 'Anónimo') AS sender, r.text 
            FROM replies r
            LEFT JOIN users u ON r.sender_id = u.id
            ORDER BY r.id ASC
        `);

        const messagesList = msgsRes.rows.map(msg => {
            return {
                id: msg.id,
                sender_id: msg.sender_id,
                sender: msg.sender,
                text: msg.text,
                replies: repliesRes.rows
                    .filter(r => r.message_id === msg.id)
                    .map(r => ({
                        id: r.id,
                        sender_id: r.sender_id,
                        sender: r.sender,
                        text: r.text
                    }))
            };
        });

        // Obtener estado de lectura del usuario para sincronización multidispositivo
        const userReads = { main: 0, threads: {} };
        if (socket.user && socket.user.id) {
            try {
                const readsRes = await pool.query(
                    'SELECT thread_id, last_read_id FROM user_reads WHERE user_id = $1',
                    [socket.user.id]
                );
                readsRes.rows.forEach(r => {
                    if (r.thread_id === 0) {
                        userReads.main = r.last_read_id;
                    } else {
                        userReads.threads[r.thread_id] = r.last_read_id;
                    }
                });
            } catch (err) {
                console.error('Error al cargar user_reads:', err);
            }
        }

        socket.emit('initial_data', {
            messages: messagesList,
            userReads
        });
    } catch (err) {
        console.error('Error al cargar datos de chat:', err);
    }

    // Registrar lectura de mensajes (chat principal o hilos)
    socket.on('mark_read', async (readData) => {
        if (!socket.user || !socket.user.id || !readData || readData.last_read_id === undefined) return;
        const threadId = readData.thread_id || 0;
        const lastReadId = parseInt(readData.last_read_id, 10);
        if (isNaN(lastReadId)) return;

        try {
            await pool.query(`
                INSERT INTO user_reads (user_id, thread_id, last_read_id, updated_at)
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, thread_id)
                DO UPDATE SET 
                    last_read_id = GREATEST(user_reads.last_read_id, EXCLUDED.last_read_id),
                    updated_at = CURRENT_TIMESTAMP
            `, [socket.user.id, threadId, lastReadId]);

            // Sincronizar en tiempo real con las otras pestañas o dispositivos del mismo usuario
            socket.to(`user_${socket.user.id}`).emit('sync_read', {
                thread_id: threadId,
                last_read_id: lastReadId
            });
        } catch (err) {
            console.error('Error al guardar mark_read:', err);
        }
    });

    socket.on('new_main_message', async (msgData) => {
        try {
            let sender_id = socket.user?.id || msgData.sender_id || msgData.senderId;
            let senderUsername = socket.user?.username || msgData.sender;

            // Si vino un senderUsername pero no tenemos sender_id, buscamos el ID del usuario
            if (!sender_id && senderUsername) {
                const uRes = await pool.query('SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [senderUsername]);
                if (uRes.rows.length > 0) {
                    sender_id = uRes.rows[0].id;
                    senderUsername = uRes.rows[0].username;
                }
            }

            // Si vino sender_id pero no username, buscamos el username para emitir a la sala
            if (sender_id && !senderUsername) {
                const uRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [sender_id]);
                if (uRes.rows.length > 0) {
                    senderUsername = uRes.rows[0].username;
                }
            }

            const text = msgData.text?.trim();
            if (!text) return;

            // Guardamos el ID numérico en la columna sender_id
            const res = await pool.query(
                'INSERT INTO messages (sender_id, text) VALUES ($1, $2) RETURNING *',
                [sender_id || null, text]
            );

            const newMsg = {
                id: res.rows[0].id,
                sender_id: res.rows[0].sender_id,
                sender: senderUsername || 'Anónimo',
                text: res.rows[0].text,
                replies: []
            };
            io.emit('receive_main_message', newMsg);

            // Enviar notificación Push en segundo plano a los demás usuarios
            sendPushNotificationToOthers(
                sender_id,
                `Mensaje de ${senderUsername || 'Alguien'}`,
                text,
                { type: 'main_message', messageId: res.rows[0].id }
            );
        } catch (err) {
            console.error('Error al guardar mensaje principal:', err);
        }
    });

    socket.on('new_thread_message', async (replyData) => {
        try {
            let sender_id = socket.user?.id || replyData.sender_id || replyData.senderId;
            let senderUsername = socket.user?.username || replyData.sender;
            const text = replyData.text?.trim();
            const messageId = replyData.message_id;
            if (!text || !messageId) return;

            if (!sender_id && senderUsername) {
                const uRes = await pool.query('SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [senderUsername]);
                if (uRes.rows.length > 0) {
                    sender_id = uRes.rows[0].id;
                    senderUsername = uRes.rows[0].username;
                }
            }

            if (sender_id && !senderUsername) {
                const uRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [sender_id]);
                if (uRes.rows.length > 0) {
                    senderUsername = uRes.rows[0].username;
                }
            }

            // Guardamos el ID numérico en la columna sender_id
            const res = await pool.query(
                'INSERT INTO replies (message_id, sender_id, text) VALUES ($1, $2, $3) RETURNING *',
                [messageId, sender_id || null, text]
            );

            io.emit('receive_thread_message', {
                id: res.rows[0].id,
                message_id: messageId,
                sender_id: res.rows[0].sender_id,
                sender: senderUsername || 'Anónimo',
                text: res.rows[0].text
            });

            // Enviar notificación Push en segundo plano
            sendPushNotificationToOthers(
                sender_id,
                `Respuesta de ${senderUsername || 'Alguien'} en un hilo`,
                text,
                { type: 'thread_message', messageId }
            );
        } catch (err) {
            console.error('Error al guardar respuesta de hilo:', err);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
});
