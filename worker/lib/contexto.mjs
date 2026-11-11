// worker/lib/contexto.mjs — carrega tudo que uma etapa precisa e oferece helpers comuns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { baixarS3, extrairPaginas, sha256, suportado, ehAudio, metadadosPdf, S3_BUCKET } from './docs.mjs';
import { transcrever } from './llm.mjs';

const require = createRequire(import.meta.url);
export const E = require('../../shared/esteira.js');
export const U = require('../../shared/util.js');
export const D = require('../../shared/decisao.js');
export const R = require('../../shared/regras.js');
export const CONF = require('../../shared/conferencia.js');

const __dir = path.dirname(fileURLToPath(import.meta.url));

export class EtapaPulada extends Error {}

export async function carregarContexto(db, job) {
  const processo = await db.collection('processos').findOne({ _id: job.idProcesso });
  if (!processo) throw new Error('Processo não encontrado');
  const { habilitado, config, clienteId } = await E.configDoProcesso(db, processo);
  if (!habilitado) throw new EtapaPulada('Análise desativada para este escritório/cliente');
  const pacote = await E.carregarPacote(db, processo.codigoEscritorio, config.pacoteChave);
  if (!pacote) throw new Error(`Pacote "${config.pacoteChave}" não encontrado`);
  if (!pacote.manualTexto && pacote.manualArquivo) {
    const f = path.join(__dir, '../../pacotes', pacote.manualArquivo);
    if (fs.existsSync(f)) pacote.manualTexto = fs.readFileSync(f, 'utf8');
  }
  let analise = await db.collection('analiseInicial').findOne({ idProcesso: processo._id });
  if (!analise) {
    await db.collection('analiseInicial').insertOne({ idProcesso: processo._id, codigoEscritorio: processo.codigoEscritorio, clienteId, criadoEm: new Date(), estado: E.ESTADOS.NA_FILA, historico: [] });
    analise = await db.collection('analiseInicial').findOne({ idProcesso: processo._id });
  }
  const escritorio = await db.collection('escritorios').findOne({ _id: processo.codigoEscritorio }, { projection: { nome: 1, nomeFantasia: 1, razaoSocial: 1 } });

  const salvar = (set, extra = {}) => db.collection('analiseInicial').updateOne({ idProcesso: processo._id }, { $set: { ...set, atualizadoEm: new Date() }, ...extra });
  const estado = (st, extra) => E.setEstado(db, processo._id, st, extra);
  const registrarUso = (u) => db.collection('analiseLlmUso').insertOne({ codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: job.etapa, ...u, em: new Date() });

  return { db, job, processo, config, pacote, analise, clienteId, escritorio, salvar, estado, registrarUso, modulo: (m) => E.moduloLigado(config, m) };
}

/**
 * Garante o texto por página de um documento (cache em analiseTextos). Áudio vira transcrição (página 1).
 * @returns {Promise<{docId, hash, paginas:[{pagina,texto,ocr}], meta}>}
 */
export async function textoDoDocumento(db, doc, { maxPaginas = 400 } = {}) {
  const docId = doc._id;
  const existentes = await db.collection('analiseTextos').find({ docId }).sort({ pagina: 1 }).toArray();
  if (existentes.length && existentes[0].size === (doc.size || null)) {
    return { docId: String(docId), hash: existentes[0].hash, paginas: existentes.map((p) => ({ pagina: p.pagina, texto: p.texto, ocr: p.ocr })), meta: existentes[0].meta || null };
  }
  if (!suportado(doc)) return { docId: String(docId), hash: null, paginas: [], meta: null };
  const buf = await baixarS3(doc.bucket || S3_BUCKET, doc.s3Key || doc.storedName);
  const hash = sha256(buf);
  let paginas;
  let meta = null;
  if (ehAudio(doc)) {
    paginas = [{ pagina: 1, texto: `[TRANSCRIÇÃO DE ÁUDIO: ${doc.originalName}]\n${await transcrever({ buffer: buf, nomeArquivo: doc.originalName })}`, ocr: false }];
  } else {
    paginas = await extrairPaginas(doc, buf, { maxPaginas });
    if (/pdf/i.test(doc.mimeType || '') || /\.pdf$/i.test(doc.originalName || '')) meta = await metadadosPdf(buf);
  }
  await db.collection('analiseTextos').deleteMany({ docId });
  if (paginas.length) {
    await db.collection('analiseTextos').insertMany(paginas.map((p) => ({
      docId, idProcesso: doc.idProcesso, pagina: p.pagina, texto: p.texto, ocr: p.ocr, hash, size: doc.size || null, meta: p.pagina === 1 ? meta : undefined, criadoEm: new Date(),
    })));
  }
  return { docId: String(docId), hash, paginas, meta };
}

export async function documentosDoProcesso(db, idProcesso, { origem } = {}) {
  const q = { idProcesso };
  if (origem === 'subsidio') q.origem = 'subsidio';
  else q.origem = { $nin: ['subsidio', 'analise-minuta'] };
  return db.collection('documentosAnexados').find(q).sort({ cadastradoEm: 1 }).toArray();
}

// páginas de um segmento (peça) já classificado
export async function paginasDoSegmento(db, seg) {
  const docId = E.oid(seg.docId);
  return db.collection('analiseTextos').find({ docId, pagina: { $gte: seg.paginaInicial, $lte: seg.paginaFinal } }).sort({ pagina: 1 })
    .project({ pagina: 1, texto: 1 }).toArray();
}

export const nomeEscritorio = (esc) => esc?.nomeFantasia || esc?.nome || esc?.razaoSocial || 'Escritório';
