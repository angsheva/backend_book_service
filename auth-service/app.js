const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const SECRET_KEY = 'PDiddy_party';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://bookcrossing:password@localhost:5432/bookcrossing_db';
const USER_CREATED_QUEUE = 'user_created';

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
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

// Регистрация пользователя
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
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ error: 'User already exists' });
    } else {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

// Авторизация пользователя
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
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Валидация токена
app.post('/validate', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.json({ valid: false });
  }
});

const PORT = 3001;
app.listen(PORT, async () => {
  console.log(`Auth service running on port ${PORT}`);
  await initDatabase();
  await connectRabbitMQ();
});