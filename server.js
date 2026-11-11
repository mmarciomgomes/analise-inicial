// server.js — serviço HTTP da Análise Inicial (VPS). O front chama /analise/* no jur, que repassa para cá com o token.
//   node server.js        (pm2: pm2 start server.js --name analise-api)
// Variáveis: MONGO_URI, DB_NAME, ANALISE_CRYPTO_KEY, ANALISE_SERVICE_TOKEN (opcional), PORT (padrão 8460),
//            AWS_* (leitura dos documentos no S3 para a conferência de peças).
'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { registerAnaliseRoutes } = require('./backend/analise-routes');

const { MONGO_URI, DB_NAME, ANALISE_SERVICE_TOKEN } = process.env;
const PORT = Number(process.env.PORT || 8460);
if (!MONGO_URI || !DB_NAME) {
  console.error(new Date(), '[analise-api] ENV incompleto: MONGO_URI e DB_NAME são obrigatórias');
  process.exit(1);
}

let clientePromessa = null;
function getDb() {
  clientePromessa ||= new MongoClient(MONGO_URI, { maxPoolSize: 10 }).connect();
  return clientePromessa.then((c) => c.db(DB_NAME));
}

const app = express();
app.disable('x-powered-by');
app.get('/ping', (_req, res) => res.json({ ok: true, service: 'analise-api' }));

// só o jur (que conhece o token) fala com este serviço
// ANALISE_SERVICE_TOKEN vazio = sem autenticação (qualquer um que alcance a porta usa a API)
const esperado = Buffer.from(ANALISE_SERVICE_TOKEN || '');
if (!ANALISE_SERVICE_TOKEN) console.warn(new Date(), '[analise-api] ATENÇÃO: sem ANALISE_SERVICE_TOKEN, a API não exige autenticação');
app.use('/analise', (req, res, next) => {
  if (!ANALISE_SERVICE_TOKEN) return next();
  const recebido = Buffer.from(String(req.get('x-analise-token') || ''));
  const ok = recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
  if (!ok) return res.status(401).json({ ok: false, error: 'não autorizado' });
  next();
});

registerAnaliseRoutes(app, { getDb });

app.listen(PORT, '0.0.0.0', () => console.log(new Date().toISOString(), '[analise-api] ouvindo na porta', PORT));
