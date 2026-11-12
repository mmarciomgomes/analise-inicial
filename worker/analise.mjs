// worker/analise.mjs — Esteira de Análise Inicial (processo separado, como o prazo.mjs).
//
//   node worker/analise.mjs          produção
//   node worker/analise.mjs teste    roda 1 ciclo e sai (útil para depurar)
//
// Rotinas:
//   - fila analiseJobs (lease + tentativas): ingestao → extracao → diligencias → triagem → subsidios → parecer → minuta
//   - abertura automática: processos novos dos clientes com analiseConfig.ativo + modulos.abertura (a cada 5 min)
//   - alertas de subsídios sem retorno e escalonamento por prazo (a cada 60 min)
import 'dotenv/config';
import os from 'node:os';
import { MongoClient } from 'mongodb';
import { E, carregarContexto, EtapaPulada } from './lib/contexto.mjs';
import * as ingestao from './stages/ingestao.mjs';
import * as extracao from './stages/extracao.mjs';
import * as diligencias from './stages/diligencias.mjs';
import * as triagem from './stages/triagem.mjs';
import * as subsidios from './stages/subsidios.mjs';
import * as parecer from './stages/parecer.mjs';
import * as minuta from './stages/minuta.mjs';

const { MONGO_URI, DB_NAME } = process.env;
if (!MONGO_URI || !DB_NAME || !process.env.OPENAI_API_KEY) {
  console.error(new Date(), '[analise] ENV incompleto: MONGO_URI, DB_NAME, OPENAI_API_KEY');
  process.exit(1);
}
const TESTE = process.argv.slice(2).some((a) => ['teste', 'test', '--teste'].includes(a));
const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCORRENCIA = Math.max(1, Number(process.env.ANALISE_CONCORRENCIA || 2));
const log = (...a) => console.log(new Date().toISOString(), '[analise]', ...a);

const ETAPAS = { ingestao, extracao, diligencias, triagem, subsidios, parecer, minuta };
const MODULO_DA_ETAPA = { ingestao: 'ingestao', extracao: 'extracao', diligencias: null, triagem: 'triagem', subsidios: 'subsidios', parecer: 'parecer', minuta: 'minuta' };

const client = new MongoClient(MONGO_URI, { maxPoolSize: 20 });
await client.connect();
const db = client.db(DB_NAME);
await E.garantirIndices(db);
log(`iniciado ${WORKER_ID} (concorrência ${CONCORRENCIA})`);

async function processarJob(job) {
  const t0 = Date.now();
  try {
    const mod = ETAPAS[job.etapa];
    if (!mod) throw new Error(`Etapa sem implementação: ${job.etapa}`);
    const ctx = await carregarContexto(db, job);
    const m = MODULO_DA_ETAPA[job.etapa];
    if (m && !ctx.modulo(m)) {
      await E.concluirJob(db, job, { pulado: `módulo ${m} desligado` });
      return;
    }
    const res = await mod.executar(ctx);
    await E.concluirJob(db, job, { ...res, ms: Date.now() - t0 });
    log(`ok ${job.etapa} ${job.idProcesso} ${Date.now() - t0}ms`, JSON.stringify(res));
  } catch (e) {
    if (e instanceof EtapaPulada) {
      await E.concluirJob(db, job, { pulado: e.message });
      return;
    }
    const final = await E.falharJob(db, job, e);
    log(`ERRO ${job.etapa} ${job.idProcesso} (tentativa ${job.attempts}${final ? ', final' : ''}):`, e.message);
    if (final && job.idProcesso) {
      await E.setEstado(db, job.idProcesso, E.ESTADOS.ERRO, { erroEtapa: job.etapa, erro: String(e.message).slice(0, 500) }).catch(() => {});
    }
  }
}

async function loopFila() {
  const ativos = new Set();
  for (;;) {
    while (ativos.size < CONCORRENCIA) {
      const job = await E.pegarJob(db, WORKER_ID);
      if (!job) break;
      const p = processarJob(job).finally(() => ativos.delete(p));
      ativos.add(p);
    }
    if (TESTE) { await Promise.all(ativos); return; }
    await new Promise((r) => setTimeout(r, ativos.size ? 1000 : 5000));
  }
}

// abertura automática: processos novos dos clientes ativos (sem esteira ainda) e com documentos
async function abrirNovos() {
  const escs = await db.collection('escritorios').find({ 'funcao.analiseInicial': true }, { projection: { _id: 1 } }).toArray();
  for (const esc of escs) {
    const cfgs = await db.collection('analiseConfig').find({ codigoEscritorio: esc._id, ativo: true, 'modulos.abertura': true }).toArray();
    for (const cfg of cfgs) {
      const q = { codigoEscritorio: esc._id, idCliente: cfg.clienteId, encerrado: { $ne: true }, esteiraAnalise: { $exists: false } };
      if (cfg.ativoDesde) q.dataCriacao = { $gte: new Date(cfg.ativoDesde) };
      const procs = await db.collection('processos').find(q).project({ _id: 1 }).sort({ dataCriacao: -1 }).limit(50).toArray();
      for (const p of procs) {
        const temDoc = await db.collection('documentosAnexados').findOne({ idProcesso: p._id, origem: { $nin: ['subsidio', 'analise-minuta'] } }, { projection: { _id: 1 } });
        if (!temDoc) continue;
        await db.collection('analiseInicial').updateOne({ idProcesso: p._id }, { $setOnInsert: { idProcesso: p._id, codigoEscritorio: esc._id, clienteId: cfg.clienteId, criadoEm: new Date(), estado: E.ESTADOS.NA_FILA, historico: [] } }, { upsert: true });
        await E.enfileirar(db, { codigoEscritorio: esc._id, idProcesso: p._id, etapa: 'ingestao', prioridade: 5, payload: { automatico: true } });
        await E.setEstado(db, p._id, E.ESTADOS.NA_FILA, { automatico: true });
        log(`abertura automática ${p._id}`);
      }
    }
  }
}

function agendar(nome, fn, ms) {
  let rodando = false;
  const tick = async () => {
    if (rodando) return;
    rodando = true;
    try { await fn(); } catch (e) { log(`${nome} erro:`, e.message); } finally { rodando = false; }
  };
  tick();
  return setInterval(tick, ms);
}

if (TESTE) {
  await abrirNovos();
  await loopFila();
  await subsidios.lembretes(db, log);
  await client.close();
  log('ciclo de teste concluído');
  process.exit(0);
} else {
  agendar('abertura', abrirNovos, 5 * 60 * 1000);
  agendar('lembretes', () => subsidios.lembretes(db, log), 60 * 60 * 1000);
  loopFila();
  const sair = async () => { log('encerrando'); await client.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', sair);
  process.on('SIGINT', sair);
}
