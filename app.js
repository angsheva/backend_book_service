const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const SECRET_KEY = 'PDiddy_party';

// Middleware для логирования всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Не забыть добавить обработку ошибок для базы данных
app.use((req, res, next) => {
  if (!db) {
    return res.status(500).json({ error: 'Database not connected' });
  }
  next();
});

// Обработчик для корневого пути
app.get('/', (req, res) => {
  res.send('Сервер работает!');
});

// Регистрация пользователя
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, hashedPassword],
      function (err) {
        if (err) {
          return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        res.json({ id: this.lastID, username });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// АВТОРИЗАЦИЯ ПОЛЬЗОВАТЕЛЯ 
app.post('/login', async (req, res) => {
  try {
    console.log('Login attempt:', req.body);
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      if (!user) {
        console.log('User not found:', username);
        return res.status(400).json({ error: 'Пользователь не найден' });
      }

      console.log('User found:', user.id, user.username);

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        console.log('Invalid password for user:', username);
        return res.status(400).json({ error: 'Неверный пароль' });
      }

      const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1h' });
      console.log('Login successful, token generated for user:', username);
      res.json({ 
        token,
        user: {
          id: user.id,
          username: user.username
        }
      });
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Middleware для проверки JWT-токена
const authenticate = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) {
    return res.status(401).json({ error: 'Токен отсутствует' });
  }

  // Убираем 'Bearer ' если есть
  const actualToken = token.startsWith('Bearer ') ? token.slice(7) : token;

  jwt.verify(actualToken, SECRET_KEY, (err, user) => {
    if (err) {
      console.error('Token verification error:', err);
      return res.status(403).json({ error: 'Неверный токен' });
    }
    req.user = user;
    next();
  });
};

// Добавление книги (требует аутентификации)
app.post('/books', authenticate, (req, res) => {
  try {
    const { title, author } = req.body;
    const ownerId = req.user.id;

    db.run(
      'INSERT INTO books (title, author, owner_id) VALUES (?, ?, ?)',
      [title, author, ownerId],
      function (err) {
        if (err) {
          console.error('Book insertion error:', err);
          return res.status(500).json({ error: 'Ошибка при добавлении книги' });
        }
        res.json({ id: this.lastID, title, author });
      }
    );
  } catch (error) {
    console.error('Book creation error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Получение списка книг пользователя (требует аутентификации)
app.get('/books', authenticate, (req, res) => {
  try {
    const ownerId = req.user.id;

    db.all('SELECT * FROM books WHERE owner_id = ?', [ownerId], (err, books) => {
      if (err) {
        console.error('Books retrieval error:', err);
        return res.status(500).json({ error: 'Ошибка при получении книг' });
      }
      res.json(books);
    });
  } catch (error) {
    console.error('Books retrieval error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Эндпоинт для отладки - показывает все зарегистрированные роуты
app.get('/debug/routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods)
      });
    } else if (middleware.name === 'router') {
      // Для роутеров, подключенных через app.use()
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          routes.push({
            path: handler.route.path,
            methods: Object.keys(handler.route.methods)
          });
        }
      });
    }
  });
  res.json(routes);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log('Доступные эндпоинты:');
  console.log('GET  / - Проверка работы сервера');
  console.log('POST /register - Регистрация пользователя');
  console.log('POST /login - Авторизация пользователя');
  console.log('POST /books - Добавление книги (требует токен)');
  console.log('GET  /books - Получение книг (требует токен)');
  console.log('GET  /debug/routes - Отладка роутов');
});