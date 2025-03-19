const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
app.use(express.json());

const SECRET_KEY = 'PDiddy_party';

// Обработчик для корневого пути
app.get('/', (req, res) => {
  res.send('Сервер работает!');
});

// Регистрация пользователя
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(
    'INSERT INTO users (username, password) VALUES (?, ?)',
    [username, hashedPassword],
    function (err) {
      if (err) {
        return res.status(400).json({ error: 'Пользователь уже существует' });
      }
      res.json({ id: this.lastID });
    }
  );
});

// Авторизация пользователя
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Неверный пароль' });
    }

    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
    res.json({ token });
  });
});

// Middleware для проверки JWT-токена
const authenticate = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) {
    return res.status(401).json({ error: 'Токен отсутствует' });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Неверный токен' });
    }
    req.user = user;
    next();
  });
};

// Добавление книги
app.post('/books', authenticate, (req, res) => {
  const { title, author } = req.body;
  const ownerId = req.user.id;

  db.run(
    'INSERT INTO books (title, author, owner_id) VALUES (?, ?, ?)',
    [title, author, ownerId],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Ошибка при добавлении книги' });
      }
      res.json({ id: this.lastID });
    }
  );
});

// Получение списка книг пользователя
app.get('/books', authenticate, (req, res) => {
  const ownerId = req.user.id;

  db.all('SELECT * FROM books WHERE owner_id = ?', [ownerId], (err, books) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка при получении книг' });
    }
    res.json(books);
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});