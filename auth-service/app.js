const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const app = express();
app.use(express.json());
app.use(cors());

const SECRET_KEY = 'PDiddy_party';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bookcrossing:password@localhost:5432/bookcrossing_db';
const USER_CREATED_QUEUE = 'user_created';

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Конфигурация Swagger
const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Auth Service API Documentation",
      version: "1.0.0",
      description: "Документация для службы авторизации.",
    },
    servers: [
      {
        url: "http://localhost:3001",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  apis: ["./*.js"], // Указываем текущий файл для сканирования JSDoc
};

// Генерация документации
const specs = swaggerJsdoc(options);

// Интеграция Swagger UI
app.use("/docs", swaggerUi.serve, swaggerUi.setup(specs));

// Обработчик корневого маршрута
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// Инициализация таблиц
async function initDatabase() {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        full_name VARCHAR(100),
        city VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    client.release();
    console.log('Auth database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Подключение к RabbitMQ
let rabbitChannel;
async function connectRabbitMQ() {
  if (rabbitChannel) return rabbitChannel;
  
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue(USER_CREATED_QUEUE, { durable: true });
    rabbitChannel = channel;
    return channel;
  } catch (error) {
    console.error('RabbitMQ connection error:', error);
    setTimeout(connectRabbitMQ, 5000);
  }
}

/**
 * Middleware для аутентификации пользователя
 * @param {Object} req - Объект запроса
 * @param {Object} res - Объект ответа
 * @param {Function} next - Следующая функция middleware
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied' });

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

/**
 * @openapi
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           format: int64
 *         username:
 *           type: string
 *         email:
 *           type: string
 *           format: email
 *         full_name:
 *           type: string
 *         city:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @openapi
 * /users:
 *   get:
 *     summary: Получить список пользователей
 *     description: Возвращает список всех пользователей (требуется аутентификация)
 *     operationId: getUsers
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список пользователей успешно получен
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       401:
 *         description: Неавторизованный доступ
 *       500:
 *         description: Ошибка сервера
 */
app.get('/users', authenticateToken, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT id, username, email, full_name, city FROM users');
    client.release();

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /register:
 *   post:
 *     summary: Регистрация пользователя
 *     description: Создает нового пользователя в системе
 *     operationId: registerUser
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, email]
 *             properties:
 *               username:
 *                 type: string
 *                 example: "john_doe"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "securepassword123"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "john@example.com"
 *               full_name:
 *                 type: string
 *                 example: "John Doe"
 *               city:
 *                 type: string
 *                 example: "Moscow"
 *     responses:
 *       201:
 *         description: Пользователь успешно зарегистрирован
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Пользователь уже существует
 *       500:
 *         description: Ошибка сервера
 */
app.post('/register', async (req, res) => {
  const { username, password, email, full_name, city } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO users (username, password, email, full_name, city) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, full_name, city',
      [username, hashedPassword, email, full_name, city]
    );
    client.release();
    
    const user = result.rows[0];
    
    // Отправляем сообщение о создании пользователя
    connectRabbitMQ().then(channel => {
      if (channel) {
        channel.sendToQueue(USER_CREATED_QUEUE, 
          Buffer.from(JSON.stringify({
            type: 'USER_CREATED',
            data: user
          })),
          { persistent: true }
        );
      }
    });
    
    const token = jwt.sign({ id: user.id, username }, SECRET_KEY, { expiresIn: '1h' });
    res.status(201).json({ token, user });

    // Оповещаем через веб-сокеты
    socketIo.emit('registration_success', { user });
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'User already exists' });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

/**
 * @openapi
 * /login:
 *   post:
 *     summary: Авторизация пользователя
 *     description: Вход пользователя в систему
 *     operationId: loginUser
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *                 example: "john_doe"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "securepassword123"
 *     responses:
 *       200:
 *         description: Успешный вход
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *       401:
 *         description: Неверные учетные данные
 *       500:
 *         description: Ошибка сервера
 */
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user.id, username }, SECRET_KEY, { expiresIn: '1h' });
    res.json({ token });

    // Оповещаем через веб-сокеты
    socketIo.emit('authentication_success', { user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * @openapi
 * /validate:
 *   post:
 *     summary: Валидация токена
 *     description: Проверяет валидность JWT токена
 *     operationId: validateToken
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Результат валидации
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   nullable: true
 */
app.post('/validate', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.json({ valid: false });
  }
});

/**
 * @openapi
 * /delete-user/{id}:
 *   delete:
 *     summary: Удаление пользователя
 *     description: Удаляет пользователя по ID (требуется аутентификация)
 *     operationId: deleteUser
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           format: int64
 *         description: ID пользователя для удаления
 *     responses:
 *       200:
 *         description: Пользователь успешно удален
 *       401:
 *         description: Неавторизованный доступ
 *       403:
 *         description: Недостаточно прав
 *       404:
 *         description: Пользователь не найден
 *       500:
 *         description: Ошибка сервера
 */
app.delete('/delete-user/:id', authenticateToken, async (req, res) => {
  const userId = parseInt(req.params.id);

  try {
    const currentUserId = req.user.id;

    if (currentUserId !== userId) {
      return res.status(403).json({ message: 'You are not allowed to delete this user' });
    }

    const client = await pool.connect();
    const selectResult = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (selectResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    await client.query(
      'DELETE FROM users WHERE id = $1',
      [userId]
    );

    client.release();

    res.status(200).json({ message: 'User deleted successfully' });

    // Оповещаем через веб-сокеты
    socketIo.emit('user_deleted', { userId });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Создание HTTP-сервера вокруг Express-приложения
const server = http.createServer(app);

// Инициализация WebSockets с правильной настройкой CORS
const socketIo = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Обработчик подключения нового клиента
socketIo.on('connection', (socket) => {
  console.log('A user connected');

  // Обработка отключения клиента
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Запускаем сервер
const PORT = 3001;
server.listen(PORT, async () => {
  console.log(`Auth service running on port ${PORT}`);
  await initDatabase();
  await connectRabbitMQ();
});