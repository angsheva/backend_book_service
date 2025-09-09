const express = require('express');
const amqp = require('amqplib');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const http = require('http');
const io = require('socket.io');
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bookcrossing:password@localhost:5432/bookcrossing_db';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Конфигурация Swagger
const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Books Service API Documentation",
      version: "1.0.0",
      description: "Документация для сервиса управления книгами.",
    },
    servers: [
      {
        url: "http://localhost:3002",
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
      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        owner_id INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'available',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    client.release();
    console.log('Books database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Подключение к RabbitMQ
let rabbitConnection;
async function connectRabbitMQ() {
  if (rabbitConnection) return rabbitConnection;
  
  try {
    rabbitConnection = await amqp.connect(RABBITMQ_URL);
    return rabbitConnection;
  } catch (error) {
    console.error('RabbitMQ connection error:', error);
    setTimeout(connectRabbitMQ, 5000);
  }
}

// Отправка события через RabbitMQ
async function sendEvent(eventType, eventData) {
  const connection = await connectRabbitMQ();
  const channel = await connection.createChannel();
  await channel.assertExchange('book_events', 'fanout', { durable: false });
  channel.publish('book_events', '', Buffer.from(JSON.stringify({
    type: eventType,
    data: eventData
  })));
}

/**
 * Middleware для аутентификации пользователя
 * @param {Object} req - Объект запроса
 * @param {Object} res - Объект ответа
 * @param {Function} next - Следующая функция middleware
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/validate`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: authHeader })
    });
    
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const { valid, user } = await response.json();
    if (valid) {
      req.user = user;
      next();
    } else {
      res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('Auth service error:', error);
    res.status(503).json({ error: 'Authentication service unavailable' });
  }
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Book:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           format: int64
 *         title:
 *           type: string
 *         author:
 *           type: string
 *         owner_id:
 *           type: integer
 *           format: int64
 *         status:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 */

/**
 * @openapi
 * /books:
 *   get:
 *     summary: Получить список книг пользователя
 *     description: Возвращает список книг, принадлежащих текущему пользователю
 *     operationId: getBooks
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список книг успешно получен
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Book'
 *       401:
 *         description: Неавторизованный доступ
 *       500:
 *         description: Ошибка сервера
 */
app.get('/books', authenticate, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM books WHERE owner_id = $1',
      [req.user.id]
    );
    client.release();
    res.json(result.rows);
  } catch (error) {
    console.error('Get books error:', error);
    res.status(500).json({ error: 'Failed to get books' });
  }
});

/**
 * @openapi
 * /books:
 *   post:
 *     summary: Создать новую книгу
 *     description: Добавляет новую книгу в коллекцию пользователя
 *     operationId: createBook
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, author]
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Война и мир"
 *               author:
 *                 type: string
 *                 example: "Лев Толстой"
 *     responses:
 *       201:
 *         description: Книга успешно создана
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Book'
 *       401:
 *         description: Неавторизованный доступ
 *       500:
 *         description: Ошибка сервера
 */
app.post('/books', authenticate, async (req, res) => {
  const { title, author } = req.body;
  
  try {
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO books (title, author, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [title, author, req.user.id]
    );
    client.release();
    
    const book = result.rows[0];
    
    // Отправляем событие о создании книги
    await sendEvent('BOOK_CREATED', book);

    // Оповещаем через веб-сокеты
    socketIo.emit('book_added', { book });
    
    res.status(201).json(book);
  } catch (error) {
    console.error('Create book error:', error);
    res.status(500).json({ error: 'Failed to create book' });
  }
});

/**
 * @openapi
 * /books/{id}/status:
 *   put:
 *     summary: Изменить статус книги
 *     description: Обновляет статус книги (available, exchanged, etc.)
 *     operationId: updateBookStatus
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           format: int64
 *         description: ID книги
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 example: "exchanged"
 *     responses:
 *       200:
 *         description: Статус книги успешно обновлен
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Book'
 *       401:
 *         description: Неавторизованный доступ
 *       404:
 *         description: Книга не найдена
 *       500:
 *         description: Ошибка сервера
 */
app.put('/books/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  
  try {
    const client = await pool.connect();
    const result = await client.query(
      'UPDATE books SET status=$1 WHERE id=$2 AND owner_id=$3 RETURNING *',
      [status, id, req.user.id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Book not found or unauthorized' });
    }
    
    const updatedBook = result.rows[0];
    client.release();
    
    // Отправляем событие о смене статуса
    await sendEvent('BOOK_STATUS_UPDATED', updatedBook);
    
    res.json(updatedBook);
  } catch (error) {
    console.error('Update book status error:', error);
    res.status(500).json({ error: 'Failed to update book status' });
  }
});

// Создание HTTP-сервера вокруг Express-приложения
const server = http.createServer(app);

// Инициализация WebSockets
const socketIo = io(server);

// Обработчик подключения нового клиента
socketIo.on('connection', (socket) => {
  console.log('A user connected');

  // Обработка отключения клиента
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

const PORT = 3002;
server.listen(PORT, async () => {
  console.log(`Books service running on port ${PORT}`);
  await initDatabase();
  await connectRabbitMQ();
});