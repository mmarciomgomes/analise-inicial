// backend/analise-routes.js — rotas da Análise Inicial para o jur.js (CommonJS).
//
// No jur.js, depois de criar o `app` e definir getDb():
//   require('./analise/backend/analise-routes').registerAnaliseRoutes(app, { getDb });
//
// Opcional: registerAnaliseRoutes(app, { getDb, baixarArquivo }) — baixarArquivo(doc) => Buffer, para reaproveitar
// o S3 do jur.js na conferência de peças (sem ele, a rota usa @aws-sdk/client-s3 com AWS_REGION).
//
// Tudo é bloqueado por escritório: sem escritorios.funcao.analiseInicial = true as rotas respondem 403
// (exceto a ponte do jus.br, autenticada por token, e a conferência de peças, que também aceita
// escritorios.funcao.conferenciaPeca = true para escritórios que só querem a conferência).
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const E = require('../shared/esteira');
const U = require('../shared/util');
const { motivoExclusao } = require('../shared/documentos');

const { oid } = E;

function registerAnaliseRoutes(app, { getDb, baixarArquivo } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));

  // garante índices uma vez
  getDb().then((db) => E.garantirIndices(db)).catch((e) => console.error(new Date(), '[analise] índices:', e.message));

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(new Date(), '[analise]', req.method, req.path, err);
    res.status(err.httpStatus || 500).json({ ok: false, error: err.message || 'Erro interno' });
  });

  const erro = (status, msg) => Object.assign(new Error(msg), { httpStatus: status });

  async function exigirHabilitado(db, codigoEscritorio) {
    const ce = oid(codigoEscritorio);
    if (!ce) throw erro(400, 'codigoEscritorio inválido');
    if (!(await E.escritorioHabilitado(db, ce))) throw erro(403, 'Análise Inicial não habilitada para este escritório.');
    return ce;
  }

  async function processoDoEscritorio(db, ce, idProcesso) {
    const p = await db.collection('processos').findOne({ _id: oid(idProcesso), codigoEscritorio: ce });
    if (!p) throw erro(404, 'Processo não encontrado.');
    return p;
  }

  /* =========================================================
   * STATUS / CONFIG / PACOTES
   * ========================================================= */

  // usado pelo front para decidir se mostra a aba (barato; não lança 403)
  r.get('/status/:codigoEscritorio', wrap(async (req, res) => {
    const db = await getDb();
    const habilitado = await E.escritorioHabilitado(db, req.params.codigoEscritorio);
    if (!habilitado) return res.json({ ok: true, habilitado: false, clientes: [] });
    const cfgs = await db.collection('analiseConfig').find({ codigoEscritorio: oid(req.params.codigoEscritorio) }, { projection: { clienteId: 1, ativo: 1, modulos: 1, pacoteChave: 1 } }).toArray();
    res.json({ ok: true, habilitado: true, clientes: cfgs });
  }));

  r.get('/config/:codigoEscritorio/:clienteId', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.params.codigoEscritorio);
    const cfg = await E.carregarConfig(db, ce, req.params.clienteId);
    res.json({ ok: true, config: cfg, modulosDisponiveis: E.MODULOS });
  }));

  r.post('/config-salvar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const clienteId = oid(req.body.clienteId);
    if (!clienteId) throw erro(400, 'clienteId inválido');
    const cfg = E.mergeConfig(req.body.config || {});
    delete cfg._id;
    const now = new Date();
    await db.collection('analiseConfig').updateOne(
      { codigoEscritorio: ce, clienteId },
      { $set: { ...cfg, codigoEscritorio: ce, clienteId, ativoDesde: cfg.ativoDesde ? new Date(cfg.ativoDesde) : null, atualizadoEm: now, atualizadoPor: oid(req.body.userId) }, $setOnInsert: { criadoEm: now } },
      { upsert: true },
    );
    res.json({ ok: true });
  }));

  r.get('/pacotes/:codigoEscritorio', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.params.codigoEscritorio);
    const lista = await db.collection('pacotesAnalise').find({ codigoEscritorio: { $in: [ce, null] } }, { projection: { manualTexto: 0 } }).toArray();
    res.json({ ok: true, pacotes: lista });
  }));

  r.get('/pacote/:codigoEscritorio/:chave', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.params.codigoEscritorio);
    const p = await E.carregarPacote(db, ce, req.params.chave);
    if (!p) throw erro(404, 'Pacote não encontrado');
    res.json({ ok: true, pacote: p });
  }));

  // salva cópia do pacote para o escritório (versão anterior vai para pacotesAnaliseHistorico)
  r.post('/pacote-salvar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const p = req.body.pacote || {};
    if (!p.chave) throw erro(400, 'pacote.chave é obrigatório');
    const atual = await db.collection('pacotesAnalise').findOne({ codigoEscritorio: ce, chave: p.chave });
    if (atual) await db.collection('pacotesAnaliseHistorico').insertOne({ ...atual, _id: undefined, pacoteId: atual._id, arquivadoEm: new Date() });
    delete p._id;
    await db.collection('pacotesAnalise').updateOne(
      { codigoEscritorio: ce, chave: p.chave },
      { $set: { ...p, codigoEscritorio: ce, atualizadoEm: new Date(), atualizadoPor: oid(req.body.userId) }, $inc: { revisao: 1 } },
      { upsert: true },
    );
    res.json({ ok: true });
  }));

  /* =========================================================
   * PROCESSO
   * ========================================================= */
  r.get('/processo/:codigoEscritorio/:idProcesso', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.params.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.params.idProcesso);
    const { habilitado, config } = await E.configDoProcesso(db, proc);
    const analise = await db.collection('analiseInicial').findOne({ idProcesso: proc._id });
    const jobs = await db.collection('analiseJobs').find({ idProcesso: proc._id }).sort({ createdAt: -1 }).limit(15)
      .project({ etapa: 1, status: 1, attempts: 1, lastError: 1, createdAt: 1, finishedAt: 1 }).toArray();
    const solicitacoes = await db.collection('subsidiosSolicitacoes').find({ idProcesso: proc._id }).sort({ criadoEm: -1 }).toArray();
    res.json({ ok: true, habilitadoCliente: habilitado, config, analise, jobs, solicitacoes, processo: { numero: proc.numeroProcessoFull || proc.numeroProcesso || null, pasta: proc.novaPasta || null } });
  }));

  // documentos do processo para escolher o que a análise lê (a inicial e seus anexos; o resto vem desmarcado)
  r.get('/documentos/:codigoEscritorio/:idProcesso', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.params.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.params.idProcesso);
    const docs = await db.collection('documentosAnexados').find({ idProcesso: proc._id, origem: { $nin: ['subsidio', 'analise-minuta'] } }).sort({ cadastradoEm: 1 }).toArray();
    const atual = await db.collection('analiseInicial').findOne({ idProcesso: proc._id }, { projection: { documentosSelecionados: 1 } });
    const sel = atual?.documentosSelecionados ? new Set(atual.documentosSelecionados.map(String)) : null;
    res.json({
      ok: true,
      selecaoAnterior: !!sel,
      documentos: docs.map((d) => {
        const motivo = motivoExclusao(d);
        return { id: String(d._id), nome: d.originalName, pasta: (d.folderPathSegments || []).join(' / '), tamanho: d.size || null, mimeType: d.mimeType || null, cadastradoEm: d.cadastradoEm || null, marcado: sel ? sel.has(String(d._id)) : !motivo, motivoExclusao: motivo };
      }),
    });
  }));

  r.post('/iniciar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const { habilitado } = await E.configDoProcesso(db, proc);
    if (!habilitado) throw erro(403, 'Análise não está ativa para o cliente deste processo.');
    const etapa = req.body.etapa || 'ingestao';
    let idsSelecionados = null;
    if (Array.isArray(req.body.docIds)) {
      const ids = req.body.docIds.map(oid).filter(Boolean);
      if (!ids.length) throw erro(400, 'Selecione ao menos um documento.');
      const validos = await db.collection('documentosAnexados').find({ _id: { $in: ids }, idProcesso: proc._id }, { projection: { _id: 1 } }).toArray();
      if (validos.length !== ids.length) throw erro(400, 'Há documentos que não pertencem a este processo.');
      idsSelecionados = ids;
    }
    await db.collection('analiseInicial').updateOne(
      { idProcesso: proc._id },
      { $setOnInsert: { idProcesso: proc._id, codigoEscritorio: ce, criadoEm: new Date(), estado: E.ESTADOS.NA_FILA, historico: [] } },
      { upsert: true },
    );
    if (idsSelecionados) {
      await db.collection('analiseInicial').updateOne({ idProcesso: proc._id }, { $set: { documentosSelecionados: idsSelecionados, documentosSelecionadosEm: new Date(), documentosSelecionadosPor: oid(req.body.userId) } });
    }
    const r1 = await E.enfileirar(db, { codigoEscritorio: ce, idProcesso: proc._id, etapa, criadoPor: req.body.userId, prioridade: 3, payload: { manual: true } });
    await E.setEstado(db, proc._id, E.ESTADOS.NA_FILA, { iniciadoPor: oid(req.body.userId) });
    res.json({ ok: true, ...r1 });
  }));

  // correção manual de um campo da ficha (fica registrada; vira caso de teste)
  r.post('/ficha-corrigir', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const caminho = String(req.body.caminho || '');
    if (!/^[a-zA-Z0-9_.]+$/.test(caminho)) throw erro(400, 'caminho inválido');
    const a = await db.collection('analiseInicial').findOne({ idProcesso: proc._id }, { projection: { ficha: 1 } });
    const anterior = caminho.split('.').reduce((o, k) => (o == null ? o : o[k]), a?.ficha);
    await db.collection('analiseInicial').updateOne({ idProcesso: proc._id }, {
      $set: { [`ficha.${caminho}`]: { valor: req.body.valor, pagina: null, trecho: 'corrigido manualmente' } },
      $push: { correcoes: { caminho, anterior, novo: req.body.valor, por: oid(req.body.userId), em: new Date() } },
    });
    res.json({ ok: true });
  }));

  // aprova a triagem (com ajustes do advogado) e gera o rascunho de subsídios
  r.post('/triagem-aprovar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const a = await db.collection('analiseInicial').findOne({ idProcesso: proc._id });
    if (!a?.triagem?.decisao) throw erro(409, 'Triagem ainda não concluída.');
    const aj = req.body.ajustes || {};
    const dec = { ...a.triagem.decisao };
    if (Array.isArray(aj.teses)) dec.teses = aj.teses;
    if (Array.isArray(aj.preliminares)) dec.preliminares = aj.preliminares;
    if (Array.isArray(aj.subsidiosSolicitar)) dec.subsidiosSolicitar = aj.subsidiosSolicitar;
    if (Array.isArray(aj.acordo)) dec.acordo = aj.acordo;
    await db.collection('analiseInicial').updateOne({ idProcesso: proc._id }, {
      $set: { 'triagem.aprovada': dec, 'triagem.aprovadaPor': oid(req.body.userId), 'triagem.aprovadaEm': new Date(), 'triagem.ajustada': Object.keys(aj).length > 0 },
    });
    if (proc.captador !== true && dec.preliminares?.some((p) => p.preliminar === 'advogado_captador')) {
      await db.collection('processos').updateOne({ _id: proc._id }, { $set: { captador: true, captadorOrigem: 'analise' } });
    }
    const r1 = await E.enfileirar(db, { codigoEscritorio: ce, idProcesso: proc._id, etapa: 'subsidios', payload: { acao: 'rascunho' }, criadoPor: req.body.userId, prioridade: 2 });
    res.json({ ok: true, ...r1 });
  }));

  // o advogado subiu o pedido no sistema do cliente (Crefisa): registra o envio e passa a aguardar o retorno
  r.post('/subsidios-enviado', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const sol = await db.collection('subsidiosSolicitacoes').findOne({ _id: oid(req.body.solicitacaoId), idProcesso: proc._id });
    if (!sol) throw erro(404, 'Solicitação não encontrada');
    if (sol.status !== 'a_enviar' && sol.status !== 'rascunho') throw erro(409, 'Este pedido já foi registrado como enviado.');
    const agora = new Date();
    const referencia = String(req.body.referencia || '').trim().slice(0, 200) || null;
    await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id }, {
      $set: { status: 'enviado', enviadoEm: agora, enviadoPor: oid(req.body.userId), referenciaSistemaCliente: referencia, ...(req.body.corpo ? { corpo: String(req.body.corpo) } : {}) },
      $push: { eventos: { tipo: 'envio_manual', em: agora, por: oid(req.body.userId), referencia } },
    });
    await E.setEstado(db, proc._id, E.ESTADOS.AGUARDANDO_SUBSIDIOS);
    res.json({ ok: true });
  }));

  // o cliente respondeu no sistema dele: o advogado baixou os arquivos e os subiu em Documentos do processo
  // (documentos-anexados-insere); aqui eles são ligados ao pedido e a esteira lê o que chegou (checklist).
  r.post('/subsidios-receber', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const sol = await db.collection('subsidiosSolicitacoes').findOne({ _id: oid(req.body.solicitacaoId), idProcesso: proc._id });
    if (!sol) throw erro(404, 'Solicitação não encontrada');
    if (sol.status === 'a_enviar' || sol.status === 'rascunho') throw erro(409, 'Registre primeiro que o pedido foi enviado ao cliente.');
    const ids = (Array.isArray(req.body.docIds) ? req.body.docIds : []).map(oid).filter(Boolean);
    if (!ids.length) throw erro(400, 'Envie ao menos um arquivo.');
    const validos = await db.collection('documentosAnexados').find({ _id: { $in: ids }, idProcesso: proc._id }, { projection: { _id: 1 } }).toArray();
    if (validos.length !== ids.length) throw erro(400, 'Há documentos que não pertencem a este processo.');
    const agora = new Date();
    await db.collection('documentosAnexados').updateMany({ _id: { $in: ids } }, { $set: { origem: 'subsidio', subsidioSolicitacaoId: sol._id, subsidioRecebidoEm: agora } });
    await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id }, { $push: { eventos: { tipo: 'retorno', em: agora, por: oid(req.body.userId), anexos: ids.length } } });
    const r1 = await E.enfileirar(db, { codigoEscritorio: ce, idProcesso: proc._id, etapa: 'subsidios', prioridade: 2, criadoPor: req.body.userId, payload: { acao: 'recebido', solicitacaoId: String(sol._id), docIds: ids.map(String) }, chave: `subsidios:recebido:${sol._id}:${ids.map(String).sort().join(',').slice(0, 200)}` });
    res.json({ ok: true, ...r1 });
  }));

  // marca manualmente item do checklist como recebido / pendente
  r.post('/subsidio-marcar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    await db.collection('subsidiosSolicitacoes').updateOne(
      { _id: oid(req.body.solicitacaoId), idProcesso: proc._id, 'itens.item': req.body.item },
      { $set: { 'itens.$.recebido': !!req.body.recebido, 'itens.$.marcadoManual': true, 'itens.$.marcadoPor': oid(req.body.userId) } },
    );
    res.json({ ok: true });
  }));

  // subsídios suficientes: gera o parecer (o advogado decide quando, mesmo com pendências)
  r.post('/subsidios-concluir', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const r1 = await E.enfileirar(db, { codigoEscritorio: ce, idProcesso: proc._id, etapa: 'parecer', criadoPor: req.body.userId, prioridade: 2, payload: { decisaoJudicial: req.body.decisaoJudicial || null } });
    res.json({ ok: true, ...r1 });
  }));

  r.post('/parecer-aprovar', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirHabilitado(db, req.body.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.body.idProcesso);
    const a = await db.collection('analiseInicial').findOne({ idProcesso: proc._id }, { projection: { parecer: 1 } });
    if (!a?.parecer?.decisao) throw erro(409, 'Parecer ainda não gerado.');
    await db.collection('analiseInicial').updateOne({ idProcesso: proc._id }, { $set: { 'parecer.aprovadoPor': oid(req.body.userId), 'parecer.aprovadoEm': new Date(), 'parecer.observacao': req.body.observacao || null } });
    const r1 = await E.enfileirar(db, { codigoEscritorio: ce, idProcesso: proc._id, etapa: 'minuta', criadoPor: req.body.userId, prioridade: 2, payload: { advogado: req.body.advogado || null } });
    res.json({ ok: true, ...r1 });
  }));

  /* =========================================================
   * CONFERÊNCIA DE PEÇAS (.docx)
   * Liberada para quem tem funcao.analiseInicial OU funcao.conferenciaPeca.
   * Router próprio porque o arquivo pode vir em base64 (até ~30 MB).
   * ========================================================= */
  const rc = express.Router();
  const C = require('../shared/conferencia');
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  async function exigirConferencia(db, codigoEscritorio) {
    const ce = oid(codigoEscritorio);
    if (!ce) throw erro(400, 'codigoEscritorio inválido');
    if (!(await E.conferenciaHabilitada(db, ce))) throw erro(403, 'Conferência de peças não habilitada para este escritório.');
    return ce;
  }

  let s3Client = null;
  async function baixarDocumento(doc) {
    if (typeof baixarArquivo === 'function') return baixarArquivo(doc); // o jur.js pode passar o próprio baixador
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const bucket = doc.bucket || process.env.S3_BUCKET_ANALISE || 'gomjur-br';
    s3Client ||= new S3Client({ region: process.env.AWS_REGION || 'sa-east-1' });
    const out = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: doc.s3Key || doc.storedName }));
    const partes = [];
    for await (const c of out.Body) partes.push(c);
    return Buffer.concat(partes);
  }

  // body: { codigoEscritorio, userId, docId? | arquivoBase64 + nomeArquivo, idProcesso?, modo?, anotar? }
  // anotar=true devolve o .docx com comentários; senão devolve o relatório em JSON.
  rc.post('/conferir', express.json({ limit: '45mb' }), wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirConferencia(db, req.body.codigoEscritorio);
    let buf; let nomeArquivo = req.body.nomeArquivo || 'peca.docx'; let docAnexo = null;
    if (req.body.docId) {
      docAnexo = await db.collection('documentosAnexados').findOne({ _id: oid(req.body.docId), codigoEscritorio: ce });
      if (!docAnexo) throw erro(404, 'Documento não encontrado.');
      nomeArquivo = docAnexo.originalName || nomeArquivo;
      buf = await baixarDocumento(docAnexo);
    } else if (req.body.arquivoBase64) {
      buf = Buffer.from(String(req.body.arquivoBase64).replace(/^data:[^,]*,/, ''), 'base64');
    } else throw erro(400, 'Envie docId ou arquivoBase64.');
    const ehPdf = buf.subarray(0, 4).toString('latin1') === '%PDF';
    if (!ehPdf && buf.subarray(0, 2).toString('latin1') !== 'PK') throw erro(400, 'A conferência lê arquivos .docx (Word) e .pdf.');
    if (ehPdf && req.body.anotar) throw erro(400, 'A cópia com comentários só existe para .docx.');

    // dados do processo (opcionais): número, parte, polo, contratos e pedidos da Análise Inicial
    const idProcesso = req.body.idProcesso || docAnexo?.idProcesso;
    let proc = null; let pacote = null; let analise = null;
    if (idProcesso) {
      proc = await processoDoEscritorio(db, ce, idProcesso);
      const { config } = await E.configDoProcesso(db, proc).catch(() => ({ config: null }));
      if (config?.pacoteChave) pacote = await E.carregarPacote(db, ce, config.pacoteChave);
      analise = await db.collection('analiseInicial').findOne({ idProcesso: proc._id }, { projection: { ficha: 1, 'triagem.aprovada': 1, 'parecer.decisao': 1 } });
    }
    // sem Análise Inicial, confere com o cadastro (números do processo/recursos e partes)
    const P = require('../protocolo/conferencia-protocolo');
    const dados = proc ? {
      ...(analise?.ficha ? C.dadosParaConferencia({ processo: proc, analise, pacote }) : {}),
      numeroProcesso: proc.numeroProcessoFull || proc.numeroProcesso,
      numerosProcesso: P.numerosDoProcesso({}, proc),
      partes: P.nomesDasPartes(proc),
    } : null;
    const modo = req.body.modo || pacote?.conferencia?.modoPadrao || 'protocolo';

    let r;
    try {
      r = await C.conferirArquivo(buf, { modo, config: pacote?.conferencia, dados });
    } catch (e) {
      throw erro(422, `Não consegui ler o arquivo: ${e.message}`);
    }
    const reg = {
      codigoEscritorio: ce, idProcesso: proc?._id || null, docId: docAnexo?._id || null, nomeArquivo,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'), modo, ok: r.ok, resumo: r.resumo,
      achados: r.achados.slice(0, 500), versao: r.versao, pacoteChave: pacote?.chave || null,
      criadoPor: oid(req.body.userId), criadoEm: new Date(),
    };
    const ins = await db.collection('conferenciasPeca').insertOne(reg);
    if (docAnexo) {
      await db.collection('documentosAnexados').updateOne({ _id: docAnexo._id }, {
        $set: { conferencia: { id: ins.insertedId, ok: r.ok, bloqueios: r.resumo.bloqueios, alertas: r.resumo.alertas, modo, em: reg.criadoEm, sha256: reg.sha256 } },
      });
    }

    if (req.body.anotar) {
      const anotado = await C.anotarDocx(buf, r.achados);
      const nome = nomeArquivo.replace(/\.docx$/i, '') + ' - CONFERENCIA.docx';
      res.setHeader('Content-Type', MIME_DOCX);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nome)}`);
      res.setHeader('X-Conferencia-Ok', r.ok ? '1' : '0');
      res.setHeader('X-Conferencia-Id', String(ins.insertedId));
      return res.send(anotado);
    }
    res.json({ ok: true, conferenciaId: ins.insertedId, aprovada: r.ok, modo, formato: r.formato, paginas: r.paginas, resumo: r.resumo, achados: r.achados, nomes: C.NOMES_REGRA, comDadosDoProcesso: !!dados });
  }));

  rc.get('/conferencias/:codigoEscritorio/:idProcesso', wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirConferencia(db, req.params.codigoEscritorio);
    const proc = await processoDoEscritorio(db, ce, req.params.idProcesso);
    const lista = await db.collection('conferenciasPeca').find({ idProcesso: proc._id }).project({ achados: 0 }).sort({ criadoEm: -1 }).limit(50).toArray();
    res.json({ ok: true, conferencias: lista });
  }));

  // "Protocolar mesmo assim": libera o arquivo ATUAL do prazo barrado pela conferência e devolve à fila.
  // body: { codigoEscritorio, prazoId, colecao?: 'prazos', userId, motivo }
  rc.post('/conferencia-liberar', express.json(), wrap(async (req, res) => {
    const db = await getDb();
    const ce = await exigirConferencia(db, req.body.codigoEscritorio);
    const colecao = req.body.colecao || 'prazos';
    if (!['prazos', 'habilitacao'].includes(colecao)) throw erro(400, 'colecao inválida');
    const motivo = String(req.body.motivo || '').trim();
    if (motivo.length < 5) throw erro(400, 'Informe o motivo da liberação.');
    const prazo = await db.collection(colecao).findOne({ _id: oid(req.body.prazoId), codigoEscritorio: { $in: [ce, String(ce)] } });
    if (!prazo) throw erro(404, 'Prazo não encontrado.');
    const sha = prazo.protocolo?.conferencia?.sha256;
    if (!sha) throw erro(409, 'Este prazo não tem conferência registrada.');
    const agora = new Date();
    const volta = prazo.protocolo?.motivoManual === 'conferencia';
    // quem liberou e por quê fica no andamento do prazo (mesmo formato do worker: atualizadoEm/responsavel/status/descricao)
    const quem = oid(req.body.userId);
    const descricao = `Protocolo liberado mesmo com bloqueio da conferência da peça. Motivo: ${motivo}`.slice(0, 500);
    await db.collection(colecao).updateOne({ _id: prazo._id }, {
      $set: {
        'protocolo.conferenciaLiberada': { sha256: sha, por: quem, em: agora, motivo },
        ...(volta ? {
          status: 'Protocolando', 'protocolo.status': 'Protocolando', 'protocolo.giveUp': false, 'protocolo.nextRetryAt': agora,
          peticionamentoManual: false, statusPeticionamento: 'Protocolando',
          statusAtualizadoEm: agora, statusAtualizadoDescricao: descricao, statusAtualizadoPor: quem,
        } : {}),
      },
      $push: { historico: { atualizadoEm: agora, responsavel: quem, status: volta ? 'Protocolando' : String(prazo.status || ''), descricao } },
      ...(volta ? { $unset: { 'protocolo.motivoManual': '', 'protocolo.erro': '' } } : {}),
    });
    res.json({ ok: true, voltouParaFila: volta });
  }));

  // Chamada pelo worker de protocolo (jur-worker) antes de peticionar: confere a peça principal do prazo.
  // Desligada por padrão: só age se escritorios.funcao.conferenciaProtocolo = "alertar" | "bloquear".
  // body: { colecao?: 'prazos', prazoId, nomeArquivo, arquivoBase64, payload?: { tipoDocumentoPrincipal, juntadaPeticaoDe, arquivoPrincipal } }
  // resposta: { seguir: boolean, motivo? }. "seguir: false" só acontece no modo bloquear com bloqueio na peça.
  rc.post('/conferencia-protocolo', express.json({ limit: '45mb' }), wrap(async (req, res) => {
    const db = await getDb();
    const colecao = req.body.colecao || 'prazos';
    if (colecao !== 'prazos') throw erro(400, 'colecao inválida');
    const doc = await db.collection(colecao).findOne({ _id: oid(req.body.prazoId) });
    if (!doc) throw erro(404, 'Prazo não encontrado.');
    if (!req.body.arquivoBase64) throw erro(400, 'arquivoBase64 é obrigatório.');
    const esc = await db.collection('escritorios').findOne({ _id: oid(doc.codigoEscritorio) });
    const buffer = Buffer.from(String(req.body.arquivoBase64), 'base64');
    const P = require('../protocolo/conferencia-protocolo');
    const r = await P.conferirAntesDoProtocolo(db, {
      collName: colecao, doc, payload: req.body.payload || {}, esc,
      carregarArquivo: async () => ({ buffer, filename: req.body.nomeArquivo || 'principal.pdf' }),
      log: (m) => console.log(new Date().toISOString(), '[analise]', m),
    });
    res.json({ ok: true, seguir: r.seguir, motivo: r.motivo || null, pulado: r.pulado || null, erro: r.erro || null });
  }));

  // mantido para o front decidir se mostra o botão "Conferir peça" (barato; não lança 403)
  rc.get('/conferencia-status/:codigoEscritorio', wrap(async (req, res) => {
    const db = await getDb();
    res.json({ ok: true, habilitado: await E.conferenciaHabilitada(db, req.params.codigoEscritorio) });
  }));

  app.use('/analise', rc);
  app.use('/analise', r);
  return r;
}

module.exports = { registerAnaliseRoutes };
