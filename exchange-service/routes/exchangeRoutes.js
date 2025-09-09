const express = require('express');
const router = express.Router();
const pool = require('../app').pool; // Или лучше создайте отдельный файл для подключения к БД

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
router.post('/', async (req, res) => {
  const { book_id, recipient_id } = req.body;

  try {
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO exchange_requests (book_id, sender_id, recipient_id) VALUES ($1, $2, $3) RETURNING *',
      [book_id, req.user.id, recipient_id],
    );
    client.release();

    const request = result.rows[0];
    req.app.get('socketIo').emit('exchange_request_created', { request });

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
router.get('/', async (req, res) => {
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
router.put('/:request_id/approve', async (req, res) => {
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
      req.app.get('socketIo').emit('exchange_approved', { request: approvedRequest });
      res.json(approvedRequest);
    } else {
      res.status(404).json({ error: 'Request not found or unauthorized action' });
    }
  } catch (error) {
    console.error('Approve exchange request error:', error);
    res.status(500).json({ error: 'Failed to approve exchange request' });
  }
});

// Аналогично добавьте JSDoc для остальных маршрутов...

module.exports = router;