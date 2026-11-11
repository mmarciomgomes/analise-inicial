// protocolo/conferencia-protocolo.js — conferência da peça ANTES do protocolo (worker de peticionamento).
//
// Não depende da Análise Inicial: usa só o prazo e o cadastro do processo (número, números de recursos/apensos,
// partes). Se o processo tiver Análise Inicial, aproveita também contratos, CNPJ do polo e pedidos.
//
// Liga por escritório:  escritorios.funcao.conferenciaProtocolo = "alertar" | "bloquear"   (ou true = "bloquear")
//   alertar  → confere e registra; o protocolo segue sempre.
//   bloquear → peça com bloqueio vira Manual (motivo "conferencia") e não é protocolada.
// Ajustes opcionais em escritorios.conferenciaProtocolo:
//   { clientes: [idCliente…]          // só esses clientes (vazio = todos)
//     tiposIgnorar: ["guia", "substabelecimento"]   // regex (sem acento/caixa) sobre o tipo/nome da peça
//     regrasExtras, desligar, pedidos, minMaiusculas  // mesmas chaves de pacote.conferencia
//   }
// Liberação manual (advogado conferiu e quer protocolar assim mesmo): prazos.protocolo.conferenciaLiberada.sha256
// igual ao hash do arquivo atual (rota POST /analise/conferencia-liberar). Trocou o arquivo → confere de novo.
//
// Falha da própria conferência (arquivo ilegível, falta pdf-parse, etc.) NUNCA impede o protocolo: registra e segue.
'use strict';

const crypto = require('crypto');

function carregarConferencia() {
  const tentativas = [process.env.CONFERENCIA_PATH, './conferencia', '../shared/conferencia'].filter(Boolean);
  for (const t of tentativas) {
    try { return require(t); } catch (e) { if (e?.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('conferencia.js não encontrado (copie shared/conferencia.js ao lado deste arquivo ou defina CONFERENCIA_PATH).');
}

const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function modoDoEscritorio(esc) {
  const v = esc?.funcao?.conferenciaProtocolo;
  if (v === true) return 'bloquear';
  return v === 'bloquear' || v === 'alertar' ? v : null;
}

function nomesDasPartes(proc) {
  const out = [];
  const pegar = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(pegar); return; }
    if (typeof x === 'string') { out.push(x); return; }
    if (typeof x === 'object') pegar(x.nome || x.nomeParte || x.razaoSocial);
  };
  pegar(proc?.ativo); pegar(proc?.passivo); pegar(proc?.partes);
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function numerosDoProcesso(doc, proc) {
  const nums = [doc?.numeroProcesso, proc?.numeroProcesso, proc?.numeroProcessoFull];
  for (const n of [].concat(proc?.numeroProcessoHistorico || [])) nums.push(n);
  for (const d of proc?.numeroProcessoHistoricoDetalhes || []) nums.push(d?.numero, d?.numeroFull, d?.raw);
  return [...new Set(nums.map(soDigitos).filter((d) => d.length === 20))];
}

async function acharProcesso(db, doc, toOid) {
  const ce = toOid(doc.codigoEscritorio);
  const ces = [ce, String(doc.codigoEscritorio)].filter(Boolean);
  const proj = { projection: { numeroProcesso: 1, numeroProcessoFull: 1, numeroProcessoHistorico: 1, numeroProcessoHistoricoDetalhes: 1, ativo: 1, passivo: 1, partes: 1, idCliente: 1, clienteId: 1, codigoEscritorio: 1, extraFields: 1 } };
  if (doc.idProcesso) {
    const p = await db.collection('processos').findOne({ _id: toOid(doc.idProcesso), codigoEscritorio: { $in: ces } }, proj);
    if (p) return p;
  }
  const d = soDigitos(doc.numeroProcesso);
  if (!d) return null;
  return db.collection('processos').findOne({
    codigoEscritorio: { $in: ces },
    $or: [{ numeroProcesso: d }, { numeroProcessoHistorico: d }, { 'numeroProcessoHistoricoDetalhes.numero': d }],
  }, proj);
}

// Análise Inicial é opcional: se existir, acrescenta contratos/CNPJ/pedidos; se não, nada muda.
async function extrasDaAnalise(db, C, proc) {
  try {
    const analise = await db.collection('analiseInicial').findOne({ idProcesso: proc._id }, { projection: { ficha: 1, 'triagem.aprovada': 1, 'parecer.decisao': 1 } });
    if (!analise?.ficha) return { dados: null, pacoteConf: null };
    let pacote = null;
    const clienteId = proc.idCliente || proc.clienteId;
    const cfg = clienteId ? await db.collection('analiseConfig').findOne({ codigoEscritorio: proc.codigoEscritorio, clienteId }) : null;
    if (cfg?.pacoteChave) {
      pacote = (await db.collection('pacotesAnalise').findOne({ chave: cfg.pacoteChave, codigoEscritorio: proc.codigoEscritorio }))
        || (await db.collection('pacotesAnalise').findOne({ chave: cfg.pacoteChave, codigoEscritorio: null }));
    }
    return { dados: C.dadosParaConferencia({ processo: proc, analise, pacote }), pacoteConf: pacote?.conferencia || null };
  } catch {
    return { dados: null, pacoteConf: null };
  }
}

async function montarDados(db, C, doc, toOid) {
  const proc = await acharProcesso(db, doc, toOid).catch(() => null);
  const base = { numeroProcesso: doc.numeroProcesso, numerosProcesso: numerosDoProcesso(doc, proc), partes: nomesDasPartes(proc) };
  if (!proc) return { proc: null, dados: base, pacoteConf: null };
  const { dados: daAnalise, pacoteConf } = await extrasDaAnalise(db, C, proc);
  // da análise vêm contratos, CNPJ e pedidos; número e partes ficam os do cadastro (mais completos)
  const dados = daAnalise ? { ...daAnalise, ...base, parteAdversa: daAnalise.parteAdversa } : base;
  return { proc, dados, pacoteConf };
}

function resumoTexto(r) {
  // agrupa por tipo: "4× Variável do modelo não substituída (VAR_VARA, VAR_COMARCAESTADO…)"
  const grupos = new Map();
  for (const a of r.achados.filter((x) => x.severidade === 'bloqueio')) {
    const g = grupos.get(a.mensagem) || { n: 0, ex: [] };
    g.n++;
    if (g.ex.length < 2 && a.valor && a.valor.length <= 50) g.ex.push(`${a.valor}${a.local?.pagina ? ` p.${a.local.pagina}` : ''}`);
    grupos.set(a.mensagem, g);
  }
  const partes = [...grupos].map(([msg, g]) => `${g.n}× ${msg}${g.ex.length ? ` (${g.ex.join(', ')}${g.n > g.ex.length ? '…' : ''})` : ''}`);
  return `Conferência barrou o protocolo (${r.resumo.bloqueios} bloqueio(s)): ${partes.join('; ')}. Corrija a peça ou use "Protocolar mesmo assim".`;
}

/**
 * Chame no worker logo antes de peticionar.
 * @returns {Promise<{ seguir: boolean, motivo?: string, resultado?: object, pulado?: string, erro?: string }>}
 */
async function conferirAntesDoProtocolo(db, { collName, doc, payload, esc, carregarArquivo, log = () => {}, ObjectId } = {}) {
  const modo = modoDoEscritorio(esc);
  if (!modo) return { seguir: true, pulado: 'desligado' };

  const Oid = ObjectId || require('mongodb').ObjectId;
  const toOid = (v) => { if (!v) return null; if (v instanceof Oid) return v; try { return Oid.isValid(String(v)) ? new Oid(String(v)) : null; } catch { return null; } };
  const ajustes = esc?.conferenciaProtocolo || {};
  const col = db.collection(collName);

  try {
    const C = carregarConferencia();

    // tipos de peça que não se conferem (guias, procurações…)
    const tipo = semAcento([payload?.tipoDocumentoPrincipal, payload?.juntadaPeticaoDe, payload?.arquivoPrincipal?.tipoArquivo, payload?.arquivoPrincipal?.originalName, doc?.tipo, doc?.tipoPrazo].filter(Boolean).join(' | '));
    const ignorar = (ajustes.tiposIgnorar || []).find((re) => { try { return new RegExp(semAcento(re), 'i').test(tipo); } catch { return false; } });
    if (ignorar) return { seguir: true, pulado: `tipo ignorado (${ignorar})` };

    const { proc, dados, pacoteConf } = await montarDados(db, C, doc, toOid);
    const clientes = (ajustes.clientes || []).map(String);
    if (clientes.length && !clientes.includes(String(proc?.idCliente || proc?.clienteId || ''))) return { seguir: true, pulado: 'cliente fora da lista' };

    const { buffer, filename } = await carregarArquivo(payload.arquivoPrincipal, 'principal.pdf');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const { clientes: _c, tiposIgnorar: _t, ...regrasEscritorio } = ajustes;
    const config = { ...(pacoteConf || {}), ...regrasEscritorio };
    const r = await C.conferirArquivo(buffer, { modo: 'protocolo', config, dados });

    const liberada = doc?.protocolo?.conferenciaLiberada?.sha256 === sha256;
    const barrar = !r.ok && modo === 'bloquear' && !liberada;
    const agora = new Date();
    const registro = {
      origem: 'protocolo', colecao: collName, prazoId: doc._id, codigoEscritorio: toOid(doc.codigoEscritorio) || doc.codigoEscritorio,
      idProcesso: proc?._id || null, numeroProcesso: doc.numeroProcesso, nomeArquivo: filename || payload?.arquivoPrincipal?.originalName || null,
      sha256, modo, formato: r.formato, ok: r.ok, barrou: barrar, liberadaManualmente: !r.ok && liberada,
      comAnalise: !!dados.contratos, resumo: r.resumo, achados: r.achados.slice(0, 300), versao: r.versao, criadoEm: agora,
    };
    const ins = await db.collection('conferenciasPeca').insertOne(registro).catch(() => null);
    await col.updateOne({ _id: doc._id }, {
      $set: {
        'protocolo.conferencia': {
          id: ins?.insertedId || null, ok: r.ok, modo, formato: r.formato, sha256, em: agora, barrou: barrar,
          liberadaManualmente: !r.ok && liberada, bloqueios: r.resumo.bloqueios, alertas: r.resumo.alertas,
          achados: r.achados.filter((a) => a.severidade !== 'info').slice(0, 30),
        },
      },
    });

    if (barrar) return { seguir: false, motivo: resumoTexto(r), resultado: r };
    if (!r.ok) log(`[conferencia] ${String(doc._id)}: ${r.resumo.bloqueios} bloqueio(s) — ${liberada ? 'liberada manualmente' : 'modo alertar'}; segue para protocolo`);
    return { seguir: true, resultado: r };
  } catch (e) {
    // a conferência nunca impede o protocolo por falha própria
    log(`[conferencia] falhou para ${String(doc?._id)} (segue para protocolo): ${e.message}`);
    await col.updateOne({ _id: doc._id }, { $set: { 'protocolo.conferencia': { erro: String(e.message).slice(0, 500), modo, em: new Date() } } }).catch(() => {});
    return { seguir: true, erro: e.message };
  }
}

// Marca o prazo como Manual por causa da conferência (mesmos campos do markManual do worker + motivo).
async function marcarBarradoPelaConferencia(db, collName, doc, motivo, STATUS = { MANUAL: 'Manual' }) {
  const agora = new Date();
  await db.collection(collName).updateOne({ _id: doc._id }, {
    $set: {
      status: STATUS.MANUAL,
      'protocolo.status': STATUS.MANUAL,
      'protocolo.erro': motivo,
      'protocolo.lastErrorAt': agora,
      'protocolo.lastErrorMessage': motivo,
      'protocolo.motivoManual': 'conferencia',
      'protocolo.giveUp': true,
      peticionamentoManual: true,
      statusPeticionamento: STATUS.MANUAL,
    },
    $unset: { 'protocolo.lockOwner': '', 'protocolo.lockedAt': '', 'protocolo.nextRetryAt': '' },
  });
}

module.exports = { conferirAntesDoProtocolo, marcarBarradoPelaConferencia, modoDoEscritorio, nomesDasPartes, numerosDoProcesso };
