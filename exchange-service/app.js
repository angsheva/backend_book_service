// Импортируем зависимости
const express = require('express');
const amqp = require('amqplib');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const http = require('http');
const io = require('socket.io');
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());

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
      title: "Exchange Service API Documentation",
      version: "1.0.0",
      description: "Документация для сервиса обмена книгами.",
    },
    servers: [
      {
        url: "http://localhost:3003",
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

// Обработчик корневого маршрута: перенаправляем на документацию Swagger
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// Подключаемся к PostgreSQL
pool.on('error', (err) => {
  console.error('PostgreSQL connection error:', err.stack);
});

// Инициализация таблиц
async function initDatabase() {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS exchange_requests (
        id SERIAL PRIMARY KEY,
        book_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        recipient_id INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    client.release();
    console.log('Exchange database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
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
      body: JSON.stringify({ token: authHeader }),
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

// Подключение к RabbitMQ и подписка на события
async function setupRabbitMQ() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    await channel.assertExchange('book_events', 'fanout', { durable: false });

    const q = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(q.queue, 'book_events', '');

    channel.consume(q.queue, (msg) => {
      if (msg !== null) {
        const event = JSON.parse(msg.content.toString());
        console.log('Received event:', event);
        // Обработка событий о книгах
        channel.ack(msg);
      }
    });
  } catch (error) {
    console.error('RabbitMQ setup error:', error);
    setTimeout(setupRabbitMQ, 5000);
  }
}

/**
 * @openapi
 * components:
 *   schemas:
 *     ExchangeRequest:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           format: int64
 *         book_id:
 *           type: integer
 *           format: int64
 *         sender_id:
 *           type: integer
 *           format: int64
 *         recipient_id:
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
 * /exchange-requests:
 *   post:
 *     summary: Создать новую заявку на обмен книгами
 *     description: Создает новую заявку на обмен книгами между пользователями
 *     operationId: createExchangeRequest
 *     tags: [Exchange Requests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [book_id, recipient_id]
 *             properties:
 *               book_id:
 *                 type: integer
 *                 format: int64
 *                 example: 123
 *               recipient_id:
 *                 type: integer
 *                 format: int64
 *                 example: 456
 *     responses:
 *       201:
 *         description: Заявка на обмен успешно создана
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRequest'
 *       401:
 *         description: Неавторизованный доступ
 *       500:
 *         description: Ошибка сервера
 */
app.post('/exchange-requests', authenticate, async (req, res) => {
  const { book_id, recipient_id } = req.body;

  try {
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO exchange_requests (book_id, sender_id, recipient_id) VALUES ($1, $2, $3) RETURNING *',
      [book_id, req.user.id, recipient_id],
    );
    client.release();

    const request = result.rows[0];

    // Оповещаем через веб-сокеты
    socketIo.emit('exchange_request_created', { request });

    res.status(201).json(request);
  } catch (error) {
    console.error('Create exchange request error:', error);
    res.status(500).json({ error: 'Failed to create exchange request' });
  }
});

/**
 * @openapi
 * /exchange-requests:
 *   get:
 *     summary: Получить список моих заявок на обмен
 *     description: Возвращает список всех заявок на обмен для текущего пользователя
 *     operationId: getMyExchangeRequests
 *     tags: [Exchange Requests]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список заявок успешно получен
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ExchangeRequest'
 *       401:
 *         description: Неавторизованный доступ
 *       500:
 *         description: Ошибка сервера
 */
app.get('/exchange-requests', authenticate, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM exchange_requests WHERE sender_id = $1 OR recipient_id = $1',
      [req.user.id],
    );
    client.release();

    res.json(result.rows);
  } catch (error) {
    console.error('Get exchange requests error:', error);
    res.status(500).json({ error: 'Failed to get exchange requests' });
  }
});

/**
 * @openapi
 * /exchange-requests/{request_id}/approve:
 *   put:
 *     summary: Одобрить заявку на обмен книгами
 *     description: Одобряет заявку на обмен книгами (только для получателя)
 *     operationId: approveExchangeRequest
 *     tags: [Exchange Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: request_id
 *         required: true
 *         schema:
 *           type: integer
 *           format: int64
 *         description: ID заявки на обмен
 *     responses:
 *       200:
 *         description: Заявка успешно одобрена
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRequest'
 *       401:
 *         description: Неавторизованный доступ
 *       404:
 *         description: Заявка не найдена
 *       500:
 *         description: Ошибка сервера
 */
app.put('/exchange-requests/:request_id/approve', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'approved\' WHERE id = $1 AND recipient_id = $2 RETURNING *',
      [requestId, req.user.id],
    );
    client.release();

    if (updateResult.rowCount > 0) {
      const approvedRequest = updateResult.rows[0];

      // Оповещаем через веб-сокеты
      socketIo.emit('exchange_approved', { request: approvedRequest });

      res.json(approvedRequest);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Approve exchange request error:', error);
    res.status(500).json({ error: 'Failed to approve exchange request' });
  }
});

/**
 * @openapi
 * /exchange-requests/{request_id}/complete:
 *   put:
 *     summary: Завершить заявку на обмен книгами
 *     description: Завершает заявку на обмен книгами (доступно для отправителя и получателя)
 *     operationId: completeExchangeRequest
 *     tags: [Exchange Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: request_id
 *         required: true
 *         schema:
 *           type: integer
 *           format: int64
 *         description: ID заявки на обмен
 *     responses:
 *       200:
 *         description: Заявка успешно завершена
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRequest'
 *       401:
 *         description: Неавторизованный доступ
 *       404:
 *         description: Заявка не найдена
 *       500:
 *         description: Ошибка сервера
 */
app.put('/exchange-requests/:request_id/complete', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'completed\' WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2) RETURNING *',
      [requestId, req.user.id],
    );
    client.release();

    if (updateResult.rowCount > 0) {
      const completedRequest = updateResult.rows[0];

      // Оповещаем через веб-сокеты
      socketIo.emit('exchange_completed', { request: completedRequest });

      res.json(completedRequest);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Complete exchange request error:', error);
    res.status(500).json({ error: 'Failed to complete exchange request' });
  }
});

/**
 * @openapi
 * /exchange-requests/{request_id}/reject:
 *   put:
 *     summary: Отклонить заявку на обмен книгами
 *     description: Отклоняет заявку на обмен книгами (только для получателя)
 *     operationId: rejectExchangeRequest
 *     tags: [Exchange Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: request_id
 *         required: true
 *         schema:
 *           type: integer
 *           format: int64
 *         description: ID заявки на обмен
 *     responses:
 *       200:
 *         description: Заявка успешно отклонена
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExchangeRequest'
 *       401:
 *         description: Неавторизованный доступ
 *       404:
 *         description: Заявка не найдена
 *       500:
 *         description: Ошибка сервера
 */
app.put('/exchange-requests/:request_id/reject', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'rejected\' WHERE id = $1 AND recipient_id = $2 RETURNING *',
      [requestId, req.user.id],
    );
    client.release();

    if (updateResult.rowCount > 0) {
      const rejectedRequest = updateResult.rows[0];

      // Оповещаем через веб-сокеты
      socketIo.emit('exchange_rejected', { request: rejectedRequest });

      res.json(rejectedRequest);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Reject exchange request error:', error);
    res.status(500).json({ error: 'Failed to reject exchange request' });
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

const PORT = 3003;
server.listen(PORT, async () => {
  console.log(`Exchange service running on port ${PORT}`);
  await initDatabase();
  await setupRabbitMQ();
});