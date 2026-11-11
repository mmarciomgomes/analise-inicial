// Rota usada pelo jur-worker: POST /analise/conferencia-protocolo (portão da conferência fora do App Runner).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId, Db } = require('./sim/fakemongo');

const tentar = (id) => { try { return require(id); } catch { return null; } };
const JSZip = [tentar('jszip'), process.env.JSZIP_PATH && tentar(process.env.JSZIP_PATH)].find((m) => typeof m?.loadAsync === 'function');
const express = tentar('express') || (process.env.EXPRESS_PATH && tentar(process.env.EXPRESS_PATH));
const pular = (!JSZip && 'jszip não instalado') || (!express && 'express não instalado (npm i, ou EXPRESS_PATH=/caminho/express)');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function docx(linhas) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${linhas.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function subir(db) {
  require.cache[require.resolve('../backend/analise-routes')] = undefined; // módulo novo a cada teste
  const { registerAnaliseRoutes } = require('../backend/analise-routes');
  const app = express();
  registerAnaliseRoutes(app, { getDb: async () => db });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const post = (path, body) => new Promise((resolve, reject) => {
    const dados = JSON.stringify(body);
    const req = http.request({ port: srv.address().port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
    req.on('error', reject); req.end(dados);
  });
  return { post, fechar: () => srv.close() };
}

async function cenario(funcao) {
  global.__FAKE_DB = undefined;
  const db = new Db();
  const ce = new ObjectId();
  await db.collection('escritorios').insertOne({ _id: ce, funcao });
  const prazo = { _id: new ObjectId(), codigoEscritorio: String(ce), numeroProcesso: '10012345620268260100', status: 'Processando', protocolo: {} };
  await db.collection('prazos').insertOne(prazo);
  return { db, prazo };
}
const payload = { tipoDocumentoPrincipal: 'Petição', arquivoPrincipal: { originalName: 'contestacao.docx' } };

test('rota: escritório sem a flag segue sempre', { skip: pular }, async () => {
  const { db, prazo } = await cenario({});
  const s = await subir(db);
  const arquivoBase64 = (await docx(['Texto com VAR_VARA sobrando'])).toString('base64');
  const r = await s.post('/analise/conferencia-protocolo', { prazoId: String(prazo._id), arquivoBase64, payload });
  s.fechar();
  assert.equal(r.status, 200);
  assert.equal(r.body.seguir, true);
  assert.equal(r.body.pulado, 'desligado');
});

test('rota: modo bloquear barra peça com sobra de modelo e devolve o motivo', { skip: pular }, async () => {
  const { db, prazo } = await cenario({ conferenciaProtocolo: 'bloquear' });
  const s = await subir(db);
  const arquivoBase64 = (await docx(['Excelentíssimo Senhor Juiz da VAR_VARA', 'Processo 1001234-56.2026.8.26.0100'])).toString('base64');
  const r = await s.post('/analise/conferencia-protocolo', { prazoId: String(prazo._id), nomeArquivo: 'contestacao.docx', arquivoBase64, payload });
  s.fechar();
  assert.equal(r.status, 200);
  assert.equal(r.body.seguir, false);
  assert.match(r.body.motivo, /Conferência barrou o protocolo/);
});

test('rota: prazo inexistente e arquivo ausente respondem erro claro', { skip: pular }, async () => {
  const { db, prazo } = await cenario({ conferenciaProtocolo: 'bloquear' });
  const s = await subir(db);
  const a = await s.post('/analise/conferencia-protocolo', { prazoId: String(new ObjectId()), arquivoBase64: 'AA==' });
  const b = await s.post('/analise/conferencia-protocolo', { prazoId: String(prazo._id) });
  s.fechar();
  assert.equal(a.status, 404);
  assert.equal(b.status, 400);
});
