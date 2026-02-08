const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Конфигурация JSONBin.io
const JSON_BIN_ID = "69884cadae596e708f1a1337";
const JSON_BIN_MASTER_KEY = "$2a$10$4t3iUbvJYJRQL0V.G8YE2.01PSIcL0N3EmIdQOI2Wgl0vHac44ikm";
const JSON_BIN_ACCESS_KEY = "$2a$10$I2I96lPMR/JKjetj1oc93eTQG.dkoeYEtV1j88hu5qFK8D0yAq6k2";

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Хранилище пользователей онлайн
const onlineUsers = new Map();
// Хранилище звонков
const activeCalls = new Map();

// Маршрут для главной страницы
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
    
    // Проверка существования пользователя
    const userExists = users.some(u => u.username === username);
    if (userExists) {
      return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
    }
    
    // Создание нового пользователя
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
    
    // Генерация ID и временной метки
    message.id = generateId();
    message.timestamp = new Date().toISOString();
    
    // Сохранение сообщения
    const messages = await fetchFromJSONBin('messages');
    messages.push(message);
    await updateJSONBin('messages', messages);
    
    res.json({ success: true, message });
    
    // Отправка уведомления через WebSocket
    const recipientSocketId = onlineUsers.get(message.receiverId);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message', {
        type: 'message',
        data: message
      });
    }
    
  } catch (error) {
    console.error('Ошибка при сохранении сообщения:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// WebSocket соединения
io.on('connection', (socket) => {
  console.log('Новый пользователь подключен:', socket.id);
  
  let currentUserId = null;
  
  // Регистрация пользователя
  socket.on('register', (data) => {
    const { userId } = data;
    currentUserId = userId;
    onlineUsers.set(userId, socket.id);
    console.log(`Пользователь ${userId} зарегистрирован с socket.id ${socket.id}`);
  });
  
  // Отправка сообщения
  socket.on('message', (data) => {
    const message = data.data;
    
    // Сохраняем сообщение в базу
    saveMessageToDB(message).catch(console.error);
    
    // Пересылка сообщения получателю, если он онлайн
    const recipientSocketId = onlineUsers.get(message.receiverId);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message', {
        type: 'message',
        data: message
      });
    }
  });
  
  // Инициация звонка
  socket.on('call', (data) => {
    const callData = data.data;
    const { callerId, recipientId, callId, isVideoCall } = callData;
    
    // Сохраняем информацию о звонке
    activeCalls.set(callId, {
      callerId,
      recipientId,
      callId,
      isVideoCall,
      callerSocketId: socket.id,
      status: 'ringing'
    });
    
    // Отправляем уведомление о звонке получателю
    const recipientSocketId = onlineUsers.get(recipientId);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call', {
        type: 'call',
        data: {
          callerId,
          callId,
          isVideoCall
        }
      });
    } else {
      // Если получатель оффлайн, уведомляем звонящего
      socket.emit('call', {
        type: 'callFailed',
        data: { callId, reason: 'Пользователь оффлайн' }
      });
    }
  });
  
  // Принятие звонка
  socket.on('callAccepted', (data) => {
    const callData = data.data;
    const { callId, recipientId } = callData;
    const call = activeCalls.get(callId);
    
    if (call && call.recipientId === recipientId) {
      call.status = 'accepted';
      call.recipientSocketId = socket.id;
      activeCalls.set(callId, call);
      
      // Уведомляем звонящего о принятии звонка
      io.to(call.callerSocketId).emit('call', {
        type: 'callAccepted',
        data: {
          callId,
          recipientId
        }
      });
    }
  });
  
  // Отклонение звонка
  socket.on('callDeclined', (data) => {
    const callData = data.data;
    const { callId, recipientId } = callData;
    const call = activeCalls.get(callId);
    
    if (call && call.recipientId === recipientId) {
      call.status = 'declined';
      activeCalls.set(callId, call);
      
      // Уведомляем звонящего об отклонении звонка
      io.to(call.callerSocketId).emit('call', {
        type: 'callDeclined',
        data: {
          callId,
          recipientId
        }
      });
    }
  });
  
  // Завершение звонка
  socket.on('callEnded', (data) => {
    const callData = data.data;
    const { callId } = callData;
    const call = activeCalls.get(callId);
    
    if (call) {
      // Уведомляем другую сторону о завершении звонка
      const otherSocketId = socket.id === call.callerSocketId ? 
        call.recipientSocketId : call.callerSocketId;
      
      if (otherSocketId) {
        io.to(otherSocketId).emit('call', {
          type: 'callEnded',
          data: { callId }
        });
      }
      
      // Удаляем информацию о звонке
      activeCalls.delete(callId);
    }
  });
  
  // WebRTC сигналы
  socket.on('webrtcSignal', (data) => {
    const signalData = data.data;
    const { to, signal, callId } = signalData;
    
    // Находим сокет получателя
    const recipientSocketId = onlineUsers.get(to);
    
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('webrtcSignal', {
        type: 'webrtcSignal',
        data: {
          from: currentUserId,
          signal,
          callId
        }
      });
    }
  });
  
  // Отключение пользователя
  socket.on('disconnect', () => {
    if (currentUserId) {
      onlineUsers.delete(currentUserId);
      
      // Завершаем активные звонки пользователя
      for (let [callId, call] of activeCalls.entries()) {
        if (call.callerId === currentUserId || call.recipientId === currentUserId) {
          const otherSocketId = call.callerId === currentUserId ? 
            call.recipientSocketId : call.callerSocketId;
          
          if (otherSocketId) {
            io.to(otherSocketId).emit('call', {
              type: 'callEnded',
              data: { 
                callId, 
                reason: 'Пользователь отключился' 
              }
            });
          }
          
          activeCalls.delete(callId);
        }
      }
    }
  });
});

// Функция сохранения сообщения в базу данных
async function saveMessageToDB(message) {
  try {
    const messages = await fetchFromJSONBin('messages');
    messages.push(message);
    await updateJSONBin('messages', messages);
  } catch (error) {
    console.error('Ошибка при сохранении сообщения в базу:', error);
  }
}

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
    
    // Если бина не существует, создаем его
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
    // Сначала получаем текущие данные
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
    
    // Обновляем нужный бин
    currentData[binName] = data;
    
    // Отправляем обновленные данные
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

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=== SkyMessage Server ===`);
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Доступен по адресу: http://localhost:${PORT}`);
  console.log(`Режим телефона доступен через кнопку в правом верхнем углу`);
  console.log(`========================`);
});
