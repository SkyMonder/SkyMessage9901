const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Конфигурация JSONBin.io
const JSON_BIN_ID = "69884cadae596e708f1a1337";
const JSON_BIN_MASTER_KEY = "$2a$10$4t3iUbvJYJRQL0V.G8YE2.01PSIcL0N3EmIdQOI2Wgl0vHac44ikm";
const JSON_BIN_ACCESS_KEY = "$2a$10$I2I96lPMR/JKjetj1oc93eTQG.dkoeYEtV1j88hu5qFK8D0yAq6k2";

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Хранилище
const onlineUsers = new Map(); // userId -> ws
const userData = new Map(); // userId -> {username, socketId}
const activeCalls = new Map(); // callId -> call data

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoints
app.get('/api/users', async (req, res) => {
    try {
        const users = await fetchFromJSONBin('users');
        res.json(users);
    } catch (error) {
        console.error('Ошибка при получении пользователей:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Необходимо указать имя пользователя и пароль' });
        }
        
        const users = await fetchFromJSONBin('users');
        
        const userExists = users.some(u => u.username === username);
        if (userExists) {
            return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
        }
        
        const newUser = {
            id: generateId(),
            username,
            password,
            registeredAt: new Date().toISOString()
        };
        
        users.push(newUser);
        await updateJSONBin('users', users);
        
        res.json({ 
            success: true, 
            user: { id: newUser.id, username: newUser.username } 
        });
        
    } catch (error) {
        console.error('Ошибка при регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Необходимо указать имя пользователя и пароль' });
        }
        
        const users = await fetchFromJSONBin('users');
        const user = users.find(u => u.username === username && u.password === password);
        
        if (user) {
            res.json({ 
                success: true, 
                user: { id: user.id, username: user.username } 
            });
        } else {
            res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
        }
        
    } catch (error) {
        console.error('Ошибка при входе:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/messages/:userId1/:userId2', async (req, res) => {
    try {
        const { userId1, userId2 } = req.params;
        const chatId = [userId1, userId2].sort().join('_');
        
        const messages = await fetchFromJSONBin('messages');
        const chatMessages = messages.filter(msg => msg.chatId === chatId);
        
        res.json(chatMessages);
    } catch (error) {
        console.error('Ошибка при получении сообщений:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/messages', async (req, res) => {
    try {
        const message = req.body;
        
        if (!message.chatId || !message.senderId || !message.text) {
            return res.status(400).json({ error: 'Неверный формат сообщения' });
        }
        
        message.id = generateId();
        message.timestamp = new Date().toISOString();
        
        const messages = await fetchFromJSONBin('messages');
        messages.push(message);
        await updateJSONBin('messages', messages);
        
        res.json({ success: true, message });
        
        // Отправляем получателю через WebSocket
        const recipientWs = onlineUsers.get(message.receiverId);
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({
                type: 'message',
                data: message
            }));
        }
        
    } catch (error) {
        console.error('Ошибка при сохранении сообщения:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// WebSocket обработка
wss.on('connection', (ws) => {
    console.log('Новое WebSocket соединение');
    
    let currentUserId = null;
    let currentUsername = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register':
                    currentUserId = data.userId;
                    currentUsername = data.username;
                    
                    onlineUsers.set(currentUserId, ws);
                    userData.set(currentUserId, { 
                        username: currentUsername, 
                        socketId: ws 
                    });
                    
                    console.log(`Пользователь ${currentUsername} (${currentUserId}) зарегистрирован`);
                    
                    // Отправляем подтверждение
                    ws.send(JSON.stringify({
                        type: 'registered',
                        userId: currentUserId
                    }));
                    break;
                    
                case 'message':
                    const messageData = data.data;
                    
                    // Сохраняем в БД
                    saveMessageToDB(messageData).catch(console.error);
                    
                    // Пересылаем получателю
                    const recipientWs = onlineUsers.get(messageData.receiverId);
                    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                        recipientWs.send(JSON.stringify({
                            type: 'message',
                            data: messageData
                        }));
                    }
                    break;
                    
                case 'call':
                    const callData = data.data;
                    const { callerId, callerName, recipientId, callId, isVideoCall } = callData;
                    
                    console.log(`Звонок от ${callerName} (${callerId}) к ${recipientId}`);
                    
                    activeCalls.set(callId, {
                        callerId,
                        callerName,
                        recipientId,
                        callId,
                        isVideoCall,
                        callerWs: ws,
                        status: 'ringing'
                    });
                    
                    // Отправляем уведомление получателю
                    const recipientWsCall = onlineUsers.get(recipientId);
                    if (recipientWsCall && recipientWsCall.readyState === WebSocket.OPEN) {
                        recipientWsCall.send(JSON.stringify({
                            type: 'call',
                            data: {
                                callerId,
                                callerName,
                                callId,
                                isVideoCall
                            }
                        }));
                        console.log(`Уведомление о звонке отправлено пользователю ${recipientId}`);
                    } else {
                        // Если получатель оффлайн
                        ws.send(JSON.stringify({
                            type: 'callFailed',
                            data: { callId, reason: 'Пользователь оффлайн' }
                        }));
                    }
                    break;
                    
                case 'callAccepted':
                    const acceptData = data.data;
                    const callIdAccept = acceptData.callId;
                    const callAccept = activeCalls.get(callIdAccept);
                    
                    if (callAccept && callAccept.recipientId === currentUserId) {
                        callAccept.status = 'accepted';
                        callAccept.recipientWs = ws;
                        activeCalls.set(callIdAccept, callAccept);
                        
                        // Уведомляем звонящего
                        if (callAccept.callerWs && callAccept.callerWs.readyState === WebSocket.OPEN) {
                            callAccept.callerWs.send(JSON.stringify({
                                type: 'callAccepted',
                                data: {
                                    callId: callIdAccept,
                                    recipientId: currentUserId
                                }
                            }));
                        }
                        console.log(`Звонок ${callIdAccept} принят`);
                    }
                    break;
                    
                case 'callDeclined':
                    const declineData = data.data;
                    const callIdDecline = declineData.callId;
                    const callDecline = activeCalls.get(callIdDecline);
                    
                    if (callDecline && callDecline.recipientId === currentUserId) {
                        callDecline.status = 'declined';
                        activeCalls.set(callIdDecline, callDecline);
                        
                        // Уведомляем звонящего
                        if (callDecline.callerWs && callDecline.callerWs.readyState === WebSocket.OPEN) {
                            callDecline.callerWs.send(JSON.stringify({
                                type: 'callDeclined',
                                data: {
                                    callId: callIdDecline,
                                    recipientId: currentUserId
                                }
                            }));
                        }
                        console.log(`Звонок ${callIdDecline} отклонен`);
                    }
                    break;
                    
                case 'callEnded':
                    const endData = data.data;
                    const callIdEnd = endData.callId;
                    const callEnd = activeCalls.get(callIdEnd);
                    
                    if (callEnd) {
                        // Уведомляем другую сторону
                        const otherWs = ws === callEnd.callerWs ? callEnd.recipientWs : callEnd.callerWs;
                        if (otherWs && otherWs.readyState === WebSocket.OPEN) {
                            otherWs.send(JSON.stringify({
                                type: 'callEnded',
                                data: { callId: callIdEnd }
                            }));
                        }
                        
                        activeCalls.delete(callIdEnd);
                        console.log(`Звонок ${callIdEnd} завершен`);
                    }
                    break;
                    
                case 'webrtcSignal':
                    const signalData = data.data;
                    const targetUserId = signalData.to;
                    
                    // Пересылаем сигнал получателю
                    const targetWs = onlineUsers.get(targetUserId);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({
                            type: 'webrtcSignal',
                            data: {
                                from: currentUserId,
                                signal: signalData.signal,
                                callId: signalData.callId
                            }
                        }));
                    }
                    break;
            }
        } catch (error) {
            console.error('Ошибка обработки WebSocket сообщения:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`WebSocket соединение закрыто для пользователя ${currentUsername}`);
        
        if (currentUserId) {
            onlineUsers.delete(currentUserId);
            userData.delete(currentUserId);
            
            // Завершаем активные звонки пользователя
            for (const [callId, call] of activeCalls.entries()) {
                if (call.callerId === currentUserId || call.recipientId === currentUserId) {
                    const otherWs = ws === call.callerWs ? call.recipientWs : call.callerWs;
                    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
                        otherWs.send(JSON.stringify({
                            type: 'callEnded',
                            data: { 
                                callId, 
                                reason: 'Пользователь отключился' 
                            }
                        }));
                    }
                    activeCalls.delete(callId);
                }
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error);
    });
    
    // Отправляем приветственное сообщение
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'WebSocket соединение установлено'
    }));
});

// Функции для работы с JSONBin.io
async function fetchFromJSONBin(binName) {
    try {
        const response = await axios.get(`https://api.jsonbin.io/v3/b/${JSON_BIN_ID}/latest`, {
            headers: {
                'X-Master-Key': JSON_BIN_MASTER_KEY,
                'X-Access-Key': JSON_BIN_ACCESS_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        const data = response.data;
        const record = data.record || {};
        
        if (!record[binName]) {
            record[binName] = binName === 'users' ? [] : [];
            await updateJSONBin(binName, record[binName]);
        }
        
        return record[binName];
    } catch (error) {
        console.error(`Ошибка при загрузке данных из ${binName}:`, error.message);
        return binName === 'users' ? [] : [];
    }
}

async function updateJSONBin(binName, data) {
    try {
        const response = await axios.get(`https://api.jsonbin.io/v3/b/${JSON_BIN_ID}`, {
            headers: {
                'X-Master-Key': JSON_BIN_MASTER_KEY,
                'X-Access-Key': JSON_BIN_ACCESS_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        let currentData = {};
        if (response.status === 200) {
            currentData = response.data.record || {};
        }
        
        currentData[binName] = data;
        
        await axios.put(`https://api.jsonbin.io/v3/b/${JSON_BIN_ID}`, currentData, {
            headers: {
                'X-Master-Key': JSON_BIN_MASTER_KEY,
                'X-Access-Key': JSON_BIN_ACCESS_KEY,
                'Content-Type': 'application/json'
            }
        });
        
        return true;
    } catch (error) {
        console.error(`Ошибка при обновлении ${binName}:`, error.message);
        throw error;
    }
}

async function saveMessageToDB(message) {
    try {
        const messages = await fetchFromJSONBin('messages');
        messages.push(message);
        await updateJSONBin('messages', messages);
    } catch (error) {
        console.error('Ошибка при сохранении сообщения в базу:', error);
    }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=== SkyMessage Server ===`);
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Доступен по адресу: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    console.log(`========================`);
    console.log(`Устранены проблемы:`);
    console.log(`1. Работает WebSocket соединение`);
    console.log(`2. Сообщения приходят в реальном времени`);
    console.log(`3. Уведомления о звонках работают`);
    console.log(`4. Не нужно обновлять страницу`);
    console.log(`========================`);
});
