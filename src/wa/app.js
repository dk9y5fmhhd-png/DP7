'use strict';

// Internal HTTP API of the WhatsApp process. Only the web app may call it.

const express = require('express');
const crypto = require('crypto');
const { WaError } = require('./service');

function createApp({ service, token, isReady }) {
  const app = express();
  app.disable('x-powered-by');

  // Unauthenticated, for the platform's health check; says nothing sensitive.
  app.get('/health', (_req, res) => res.json({ ok: true, active: isReady() }));

  const expected = crypto.createHash('sha256').update(token || '').digest();
  app.use('/internal', (req, res, next) => {
    const sent = crypto.createHash('sha256').update(String(req.get('x-wa-token') || '')).digest();
    if (!token || token.length < 32 || !crypto.timingSafeEqual(sent, expected)) {
      return res.status(401).json({ message: 'Not allowed.' });
    }
    if (!isReady()) return res.status(503).json({ message: 'The WhatsApp service is still starting. Try again shortly.' });
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  const id = (req) => {
    if (!/^\d{1,9}$/.test(req.params.id)) throw new WaError(404, 'WhatsApp number not found.');
    return Number(req.params.id);
  };
  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (!err.status) console.error('[wa]', err.stack || err.message);
      res.status(err.status || 500).json({ message: err.status ? err.message : 'The WhatsApp service hit an error.' });
    }
  };

  app.get('/internal/sessions/:id', route((req) => service.state(id(req))));
  app.post('/internal/sessions/:id/connect', route((req) => service.connect(id(req))));
  app.post('/internal/sessions/:id/logout', route((req) => service.logout(id(req))));
  app.post('/internal/sessions/:id/send', route((req) => service.sendText(id(req), req.body || {})));
  return app;
}

module.exports = { createApp };
