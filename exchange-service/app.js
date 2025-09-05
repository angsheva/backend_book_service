const express = require('express');
const amqp = require('amqplib');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bookcrossing:password@localhost:5432/bookcrossing_db';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
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

// Middleware аутентификации
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

// Пути для заявок
app.post('/exchange-requests', authenticate, async (req, res) => {
  const { book_id, recipient_id } = req.body;
  
  try {
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO exchange_requests (book_id, sender_id, recipient_id) VALUES ($1, $2, $3) RETURNING *',
      [book_id, req.user.id, recipient_id]
    );
    client.release();
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create exchange request error:', error);
    res.status(500).json({ error: 'Failed to create exchange request' });
  }
});

app.get('/exchange-requests', authenticate, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM exchange_requests WHERE sender_id = $1 OR recipient_id = $1',
      [req.user.id]
    );
    client.release();
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get exchange requests error:', error);
    res.status(500).json({ error: 'Failed to get exchange requests' });
  }
});

// Обработка заявок
app.put('/exchange-requests/:request_id/approve', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'approved\' WHERE id = $1 AND recipient_id = $2 RETURNING *',
      [requestId, req.user.id]
    );
    client.release();

    if (updateResult.rowCount > 0) {
      res.json(updateResult.rows[0]);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Approve exchange request error:', error);
    res.status(500).json({ error: 'Failed to approve exchange request' });
  }
});

// Завершение заявки
app.put('/exchange-requests/:request_id/complete', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'completed\' WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2) RETURNING *',
      [requestId, req.user.id]
    );
    client.release();

    if (updateResult.rowCount > 0) {
      res.json(updateResult.rows[0]);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Complete exchange request error:', error);
    res.status(500).json({ error: 'Failed to complete exchange request' });
  }
});

// Отклонение заявки
app.put('/exchange-requests/:request_id/reject', authenticate, async (req, res) => {
  const requestId = parseInt(req.params.request_id);

  try {
    const client = await pool.connect();
    const updateResult = await client.query(
      'UPDATE exchange_requests SET status = \'rejected\' WHERE id = $1 AND recipient_id = $2 RETURNING *',
      [requestId, req.user.id]
    );
    client.release();

    if (updateResult.rowCount > 0) {
      res.json(updateResult.rows[0]);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Reject exchange request error:', error);
    res.status(500).json({ error: 'Failed to reject exchange request' });
  }
});

const PORT = 3003;
app.listen(PORT, async () => {
  console.log(`Exchange service running on port ${PORT}`);
  await initDatabase();
  await setupRabbitMQ();
});