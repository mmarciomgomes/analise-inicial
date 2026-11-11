// shared/esteira.js — configuração (flags), fila de jobs, índices e caixas de e-mail.
// CommonJS: usado pelas rotas (jur.js) e pelo worker (analise.mjs).
'use strict';

const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');

const ETAPAS = ['ingestao', 'extracao', 'diligencias', 'triagem', 'subsidios', 'parecer', 'minuta', 'imap'];

const ESTADOS = {
  NA_FILA: 'NA_FILA',
  INGESTAO: 'INGESTAO',
  EXTRACAO: 'EXTRACAO',
  DILIGENCIAS: 'DILIGENCIAS',
  TRIAGEM: 'TRIAGEM',
  AGUARDANDO_REVISAO_TRIAGEM: 'AGUARDANDO_REVISAO_TRIAGEM',
  SUBSIDIOS_RASCUNHO: 'SUBSIDIOS_RASCUNHO',
  AGUARDANDO_SUBSIDIOS: 'AGUARDANDO_SUBSIDIOS',
  PARECER: 'PARECER',
  AGUARDANDO_REVISAO_PARECER: 'AGUARDANDO_REVISAO_PARECER',
  MINUTA: 'MINUTA',
  MINUTA_PRONTA: 'MINUTA_PRONTA',
  ERRO: 'ERRO',
};

const MODULOS = ['abertura', 'ingestao', 'extracao', 'diligencias.djen', 'diligencias.comprovante', 'diligencias.perfilAdvogado', 'diligencias.baseInterna', 'triagem', 'subsidios', 'parecer', 'minuta'];

const CONFIG_DEFAULT = {
  ativo: false,
  modulos: Object.fromEntries(MODULOS.map((m) => [m, false])),
  pacoteChave: null,
  ativoDesde: null,                // só processos cadastrados a partir desta data entram sozinhos
  destinatarios: {                 // listas por tipo de pedido
    subsidio: { para: [], cc: [] },
    acordo: { para: [], cc: [] },
    complemento: { para: [], cc: [] },
  },
  score: null,                     // null = SCORE_DEFAULT (shared/util.js)
  revisao: { modo: 'assistido', confiancaMinima: 0.85 }, // sombra | assistido | automatico
  limites: { llmUsdMes: null, paginasPorDocumento: 400 },
  prazoCobrancaDias: [2, 4],       // lembretes de subsídio (dias úteis aproximados)
};

const oid = (v) => {
  if (!v) return null;
  if (v instanceof ObjectId) return v;
  if (typeof v === 'string' && ObjectId.isValid(v)) return new ObjectId(v);
  if (v && typeof v.toHexString === 'function') return new ObjectId(v.toHexString());
  return null;
};

function mergeConfig(doc) {
  const d = doc || {};
  return {
    ...CONFIG_DEFAULT,
    ...d,
    modulos: { ...CONFIG_DEFAULT.modulos, ...(d.modulos || {}) },
    destinatarios: { ...CONFIG_DEFAULT.destinatarios, ...(d.destinatarios || {}) },
    revisao: { ...CONFIG_DEFAULT.revisao, ...(d.revisao || {}) },
    limites: { ...CONFIG_DEFAULT.limites, ...(d.limites || {}) },
  };
}

/* ---------- Flags ---------- */
async function escritorioHabilitado(db, codigoEscritorio) {
  const e = await db.collection('escritorios').findOne(
    { _id: oid(codigoEscritorio) },
    { projection: { 'funcao.analiseInicial': 1 } },
  );
  return e?.funcao?.analiseInicial === true;
}

// Conferência de peças: vale para quem tem a Análise Inicial ou só a função de conferência
// (escritorios.funcao.conferenciaPeca = true) ou a conferência no protocolo (funcao.conferenciaProtocolo),
// para poder ser usada por escritórios sem a esteira completa.
async function conferenciaHabilitada(db, codigoEscritorio) {
  const e = await db.collection('escritorios').findOne(
    { _id: oid(codigoEscritorio) },
    { projection: { 'funcao.analiseInicial': 1, 'funcao.conferenciaPeca': 1, 'funcao.conferenciaProtocolo': 1 } },
  );
  const f = e?.funcao || {};
  return f.analiseInicial === true || f.conferenciaPeca === true || ['alertar', 'bloquear', true].includes(f.conferenciaProtocolo);
}

async function carregarConfig(db, codigoEscritorio, clienteId) {
  if (!clienteId) return mergeConfig(null);
  const doc = await db.collection('analiseConfig').findOne({ codigoEscritorio: oid(codigoEscritorio), clienteId: oid(clienteId) });
  return mergeConfig(doc);
}

// config efetiva para um processo: flag do escritório + config do cliente do processo
async function configDoProcesso(db, processo) {
  const habil = await escritorioHabilitado(db, processo.codigoEscritorio);
  if (!habil) return { habilitado: false, config: mergeConfig(null) };
  // o jur.js grava o cliente em processos.idCliente (clienteId mantido como fallback)
  const clienteId = processo.idCliente || processo.clienteId || null;
  const config = await carregarConfig(db, processo.codigoEscritorio, clienteId);
  return { habilitado: habil && config.ativo === true, config, clienteId };
}

function moduloLigado(config, nome) {
  return config?.ativo === true && config?.modulos?.[nome] === true;
}

async function carregarPacote(db, codigoEscritorio, chave) {
  if (!chave) return null;
  // pacote do escritório tem prioridade; senão, pacote global (codigoEscritorio null)
  return (await db.collection('pacotesAnalise').findOne({ chave, codigoEscritorio: oid(codigoEscritorio) }))
    || db.collection('pacotesAnalise').findOne({ chave, codigoEscritorio: null });
}

/* ---------- Fila de jobs (mesmo padrão de calculosJobs: lease + tentativas) ---------- */
// chave: identifica o job ativo único por processo (default = etapa). Use chaves próprias quando
// o mesmo processo pode ter vários jobs legítimos da mesma etapa (ex.: um por e-mail recebido).
async function enfileirar(db, { codigoEscritorio, idProcesso, etapa, payload = {}, prioridade = 5, criadoPor = null, aPartirDe = null, chave = null }) {
  if (!ETAPAS.includes(etapa)) throw new Error(`Etapa inválida: ${etapa}`);
  const now = new Date();
  const doc = {
    codigoEscritorio: oid(codigoEscritorio),
    idProcesso: oid(idProcesso),
    etapa,
    chave: chave || etapa,
    status: 'queued',
    payload,
    prioridade,
    lockedBy: null,
    leaseUntil: new Date(0),
    executarApos: aPartirDe || now,
    attempts: 0,
    maxAttempts: 4,
    lastError: null,
    criadoPor: oid(criadoPor),
    createdAt: now,
    updatedAt: now,
  };
  try {
    const r = await db.collection('analiseJobs').insertOne(doc);
    return { ok: true, jobId: r.insertedId };
  } catch (e) {
    if (e?.code === 11000) return { ok: true, duplicado: true }; // já existe job ativo dessa etapa
    throw e;
  }
}

async function pegarJob(db, workerId, leaseMs = 10 * 60 * 1000, etapas = null) {
  const now = new Date();
  const filtro = {
    status: { $in: ['queued', 'running'] },
    leaseUntil: { $lt: now },
    executarApos: { $lte: now },
    $expr: { $lt: ['$attempts', '$maxAttempts'] },
  };
  if (etapas) filtro.etapa = { $in: etapas };
  const r = await db.collection('analiseJobs').findOneAndUpdate(
    filtro,
    { $set: { status: 'running', lockedBy: workerId, leaseUntil: new Date(now.getTime() + leaseMs), startedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { prioridade: 1, createdAt: 1 }, returnDocument: 'after' },
  );
  return r?.value !== undefined ? r.value : r; // driver 5 (value) x driver 6 (doc)
}

async function concluirJob(db, job, resultado = {}) {
  await db.collection('analiseJobs').updateOne({ _id: job._id }, { $set: { status: 'done', resultado, finishedAt: new Date(), updatedAt: new Date(), leaseUntil: new Date(0) } });
}

async function falharJob(db, job, err, { reagendarMs = 60_000 } = {}) {
  const msg = String(err?.message || err).slice(0, 1000);
  const final = (job.attempts || 0) >= (job.maxAttempts || 4);
  await db.collection('analiseJobs').updateOne({ _id: job._id }, {
    $set: {
      status: final ? 'error' : 'queued',
      lastError: msg,
      leaseUntil: new Date(0),
      executarApos: new Date(Date.now() + reagendarMs * Math.max(1, job.attempts || 1)),
      updatedAt: new Date(),
    },
  });
  return final;
}

/* ---------- Estado no processo ---------- */
async function setEstado(db, idProcesso, estado, extra = {}) {
  const now = new Date();
  await db.collection('processos').updateOne({ _id: oid(idProcesso) }, {
    $set: { 'esteiraAnalise.estado': estado, 'esteiraAnalise.atualizadoEm': now, ...Object.fromEntries(Object.entries(extra).map(([k, val]) => [`esteiraAnalise.${k}`, val])) },
  });
  await db.collection('analiseInicial').updateOne({ idProcesso: oid(idProcesso) }, {
    $set: { estado, atualizadoEm: now },
    $push: { historico: { $each: [{ estado, em: now, ...extra }], $slice: -200 } },
  });
}

/* ---------- Índices ---------- */
async function garantirIndices(db) {
  const ix = async (col, spec, opts = {}) => {
    try { await db.collection(col).createIndex(spec, opts); } catch (e) { if (e?.code !== 85 && e?.code !== 86) throw e; }
  };
  await ix('analiseJobs', { status: 1, leaseUntil: 1, executarApos: 1, prioridade: 1, createdAt: 1 });
  await ix('conferenciasPeca', { codigoEscritorio: 1, idProcesso: 1, criadoEm: -1 });
  await ix('conferenciasPeca', { docId: 1, criadoEm: -1 });
  await ix('analiseJobs', { idProcesso: 1, chave: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['queued', 'running'] } }, name: 'job_ativo_unico' });
  await ix('analiseInicial', { idProcesso: 1 }, { unique: true });
  await ix('analiseInicial', { codigoEscritorio: 1, estado: 1, atualizadoEm: -1 });
  await ix('analiseTextos', { docId: 1, pagina: 1 }, { unique: true });
  await ix('analiseConfig', { codigoEscritorio: 1, clienteId: 1 }, { unique: true });
  await ix('pacotesAnalise', { codigoEscritorio: 1, chave: 1 }, { unique: true });
  await ix('diligencias', { codigoEscritorio: 1, fonte: 1, tipo: 1, valorHash: 1, criadoEm: -1 });
  await ix('perfilAdvogado', { codigoEscritorio: 1, oab: 1, uf: 1 }, { unique: true });
  await ix('docFingerprints', { codigoEscritorio: 1, hashTexto: 1 });
  await ix('docFingerprints', { codigoEscritorio: 1, hashArquivo: 1 });
  await ix('docFingerprints', { codigoEscritorio: 1, chaveConta: 1 });
  await ix('subsidiosSolicitacoes', { codigo: 1 }, { unique: true });
  await ix('subsidiosSolicitacoes', { idProcesso: 1, criadoEm: -1 });
  await ix('analiseEmailsRecebidos', { caixaId: 1, uid: 1 }, { unique: true });
  await ix('processos', { 'esteiraAnalise.estado': 1, codigoEscritorio: 1 });
  await ix('processos', { 'extraFields.documentoOutraParte': 1, codigoEscritorio: 1 });
}

/* ---------- Segredos (senha das caixas de e-mail) ---------- */
// AES-256-GCM com ANALISE_CRYPTO_KEY (32 bytes em hex ou base64). Nunca gravar senha em texto puro.
function chave() {
  const raw = process.env.ANALISE_CRYPTO_KEY || '';
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ANALISE_CRYPTO_KEY ausente ou inválida (32 bytes em hex/base64).');
  return buf;
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const enc = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decifrar(valor) {
  if (!valor || !String(valor).startsWith('v1:')) return valor || '';
  const [, iv, tag, enc] = String(valor).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// caixa de e-mail do escritório para subsídios: coleção analiseCaixas
// { codigoEscritorio, nome, de, smtp:{host,port,secure,user,pass(cifrada)}, imap:{host,port,secure,user,pass(cifrada)}, ativo }
async function carregarCaixa(db, codigoEscritorio) {
  const c = await db.collection('analiseCaixas').findOne({ codigoEscritorio: oid(codigoEscritorio), ativo: { $ne: false } });
  if (!c) return null;
  return {
    ...c,
    smtp: c.smtp ? { ...c.smtp, pass: decifrar(c.smtp.pass) } : null,
    imap: c.imap ? { ...c.imap, pass: decifrar(c.imap.pass) } : null,
  };
}

async function enviarEmail(caixa, { para, cc, assunto, corpo, anexos = [], inReplyTo = null }) {
  const nodemailer = require('nodemailer');
  if (!caixa?.smtp?.host) throw new Error('Caixa de e-mail de subsídios não configurada (analiseCaixas).');
  const t = nodemailer.createTransport({
    host: caixa.smtp.host, port: Number(caixa.smtp.port || 465), secure: caixa.smtp.secure !== false,
    auth: { user: caixa.smtp.user, pass: caixa.smtp.pass },
  });
  const info = await t.sendMail({
    from: caixa.de || caixa.smtp.user,
    to: (para || []).join(', '),
    cc: (cc || []).length ? cc.join(', ') : undefined,
    subject: assunto,
    text: corpo,
    inReplyTo: inReplyTo || undefined,
    attachments: anexos,
  });
  return { messageId: info.messageId, aceitos: info.accepted, rejeitados: info.rejected };
}

module.exports = {
  ETAPAS, ESTADOS, MODULOS, CONFIG_DEFAULT, oid, mergeConfig,
  escritorioHabilitado, conferenciaHabilitada, carregarConfig, configDoProcesso, moduloLigado, carregarPacote,
  enfileirar, pegarJob, concluirJob, falharJob, setEstado, garantirIndices,
  cifrar, decifrar, carregarCaixa, enviarEmail,
};
