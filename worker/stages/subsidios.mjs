// Etapa 6 — subsídios: rascunho/envio dos e-mails, leitura do que chegou (checklist) e lembretes.
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaChecklist } from '../lib/schemas.mjs';
import { E, U, D, textoDoDocumento, nomeEscritorio } from '../lib/contexto.mjs';

const v = (x) => (x && typeof x === 'object' && 'valor' in x ? x.valor : x);

async function prazoContestacao(db, processo) {
  // tenta achar o prazo de contestação aberto do processo (campos variam entre layouts)
  // prazos do Gomjur: o texto está em `atividade` (descrição do item/combo) e as datas em dataFatal/dataLimite;
  // `tipo` é só P/A/M. Só vale o prazo ainda em aberto (Pendente, Manual ou em andamento do protocolo).
  const p = await db.collection('prazos').find({
    codigoEscritorio: processo.codigoEscritorio,
    $or: [{ idProcesso: processo._id }, { numeroProcesso: processo.numeroProcesso }],
    status: { $nin: ['Protocolado', 'Dispensado', 'Cumprido', 'cumprido', 'dispensado'] },
  }).sort({ dataFatal: 1, dataLimite: 1 }).limit(50).toArray().catch(() => []);
  const ehContestacao = (x) => /contesta/i.test(`${x.atividade || ''} ${x.comboDescricao || ''} ${x.descricao || ''} ${x.tipoPrazo || ''}`)
    && !/an[aá]lise/i.test(String(x.atividade || ''));
  const c = p.find(ehContestacao) || null;
  const d = c?.dataFatal || c?.dataLimite || c?.dataPrazo || c?.data || null;
  return d ? new Date(d) : null;
}

function dadosModelo(ctx, codigo, extra = {}) {
  const { processo, analise, escritorio } = ctx;
  const f = analise.ficha || {};
  const dec = analise.triagem?.aprovada || {};
  return {
    codigo,
    numeroProcesso: processo.numeroProcessoFull || processo.numeroProcesso,
    orgao: v(f?.processo?.juizo) || processo.comarca || '',
    autor: v(f?.autor?.nome) || processo.ativo?.nome || '',
    cpf: U.formatarCpf(v(f?.autor?.cpf) || U.cpfDoTexto(processo.extraFields?.documentoOutraParte) || ''),
    contratos: (f.contratos || []).map((c) => c.numero).filter(Boolean).join(', ') || 'não informados na inicial',
    teses: (dec.teses || []).map((t) => D.nomeTese(ctx.pacote, t.tese)).join('; '),
    escritorio: nomeEscritorio(escritorio),
    ...extra,
  };
}

async function criarSolicitacao(ctx, tipo, itens, extra = {}) {
  const { db, processo, config, pacote } = ctx;
  const modelo = pacote.emails?.[tipo];
  if (!modelo) throw new Error(`Modelo de e-mail "${tipo}" não existe no pacote.`);
  const codigo = `GJ-SUB-${U.tokenAleatorio(5)}`;
  const prazo = await prazoContestacao(db, processo);
  const dados = dadosModelo(ctx, codigo, { itens: itens.map((i) => ({ item: i })), prazo: prazo ? prazo.toLocaleDateString('pt-BR') : 'a confirmar', ...extra });
  const dest = config.destinatarios?.[tipo] || { para: [], cc: [] };
  const doc = {
    codigo, tipo, codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id,
    para: dest.para || [], cc: dest.cc || [],
    assunto: U.renderTemplate(modelo.assunto, dados), corpo: U.renderTemplate(modelo.corpo, dados),
    itens: itens.map((i) => ({ item: i, recebido: false, docs: [] })), status: 'rascunho', prazoContestacao: prazo,
    lembretes: 0, eventos: [{ tipo: 'criado', em: new Date() }], criadoEm: new Date(),
  };
  await db.collection('subsidiosSolicitacoes').insertOne(doc);
  return doc;
}

async function enviar(ctx, sol) {
  const { db, processo } = ctx;
  if (!sol.para?.length) return false;
  const caixa = await E.carregarCaixa(db, processo.codigoEscritorio);
  if (!caixa) return false;
  const envio = await E.enviarEmail(caixa, { para: sol.para, cc: sol.cc, assunto: sol.assunto, corpo: sol.corpo });
  await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id }, { $set: { status: 'enviado', messageId: envio.messageId, enviadoEm: new Date(), enviadoPor: null }, $push: { eventos: { tipo: 'envio_automatico', em: new Date() } } });
  return true;
}

async function rascunho(ctx) {
  const { analise } = ctx;
  const dec = analise.triagem?.aprovada;
  if (!dec) throw new Error('Triagem não aprovada.');
  const criadas = [];
  const itens = (dec.subsidiosSolicitar || []).map((x) => x.item || x);
  if (itens.length) criadas.push(await criarSolicitacao(ctx, 'subsidio', itens));
  if ((dec.acordo || []).length) {
    criadas.push(await criarSolicitacao(ctx, 'acordo', [], { motivos: dec.acordo.map((a) => ({ motivo: a.motivo })) }));
  }
  let enviadas = 0;
  if (ctx.job.payload?.autoEnviar) for (const s of criadas) if (await enviar(ctx, s)) enviadas++;
  await ctx.estado(enviadas === criadas.length && enviadas ? E.ESTADOS.AGUARDANDO_SUBSIDIOS : E.ESTADOS.SUBSIDIOS_RASCUNHO);
  return { solicitacoes: criadas.length, enviadas };
}

// chegou e-mail com anexos: lê, marca checklist; tudo recebido => parecer
async function recebido(ctx) {
  const { db, processo, pacote } = ctx;
  const sol = await db.collection('subsidiosSolicitacoes').findOne({ _id: E.oid(ctx.job.payload.solicitacaoId) });
  if (!sol) throw new Error('Solicitação não encontrada');
  const docs = await db.collection('documentosAnexados').find({ _id: { $in: (ctx.job.payload.docIds || []).map(E.oid) } }).toArray();
  const lidos = [];
  for (const d of docs) {
    const t = await textoDoDocumento(db, d);
    lidos.push({ docId: String(d._id), nome: d.originalName, inicio: t.paginas.slice(0, 3).map((p) => p.texto).join('\n').slice(0, 3500) });
  }
  if (lidos.length && sol.itens?.length) {
    const { dados } = await chamarEstruturado({
      sistema: pacote.prompts?.subsidio || 'Classifique documentos recebidos.',
      usuario: `ITENS PEDIDOS:\n${sol.itens.map((i) => `- ${i.item}`).join('\n')}\n\nDOCUMENTOS RECEBIDOS:\n${lidos.map((l) => `### docId=${l.docId} (${l.nome})\n${l.inicio}`).join('\n\n')}\n\nPara cada documento, diga o tipo e quais itens ele atende (texto exato do item).`,
      nome: 'registrar_checklist', descricao: 'Relaciona documentos recebidos aos itens pedidos', schema: schemaChecklist, registrarUso: ctx.registrarUso,
    });
    for (const d of dados.documentos) {
      for (const item of d.atendeItens) {
        await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id, 'itens.item': item }, { $set: { 'itens.$.recebido': true }, $addToSet: { 'itens.$.docs': d.docId } });
      }
      await db.collection('documentosAnexados').updateOne({ _id: E.oid(d.docId) }, { $set: { tipoSubsidio: d.tipo } });
    }
  }
  const atual = await db.collection('subsidiosSolicitacoes').findOne({ _id: sol._id });
  const faltam = (atual.itens || []).filter((i) => !i.recebido).map((i) => i.item);
  await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id }, { $set: { status: faltam.length ? 'parcial' : 'completo', faltam } });
  const outrasAbertas = await db.collection('subsidiosSolicitacoes').countDocuments({ idProcesso: processo._id, tipo: 'subsidio', status: { $in: ['enviado', 'parcial'] }, _id: { $ne: sol._id } });
  if (!faltam.length && !outrasAbertas && sol.tipo !== 'acordo') {
    await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'parecer', prioridade: 2 });
  }
  return { faltam: faltam.length };
}

async function complemento(ctx) {
  const itens = ctx.job.payload?.itens || [];
  if (!itens.length) return { nada: true };
  const sol = await criarSolicitacao(ctx, 'complemento', itens);
  return { solicitacao: String(sol._id) };
}

export async function executar(ctx) {
  const acao = ctx.job.payload?.acao || 'rascunho';
  if (!ctx.modulo('subsidios')) return { pulado: 'módulo subsidios desligado' };
  if (acao === 'rascunho') return rascunho(ctx);
  if (acao === 'recebido') return recebido(ctx);
  if (acao === 'complemento') return complemento(ctx);
  throw new Error(`Ação desconhecida: ${acao}`);
}

// rotina periódica: lembretes D+2/D+4 e escalonamento perto do prazo
export async function lembretes(db, log) {
  const abertas = await db.collection('subsidiosSolicitacoes').find({ status: { $in: ['enviado', 'parcial'] }, tipo: { $in: ['subsidio', 'complemento'] } }).limit(500).toArray();
  for (const s of abertas) {
    try {
      const proc = await db.collection('processos').findOne({ _id: s.idProcesso }, { projection: { codigoEscritorio: 1, idCliente: 1, clienteId: 1, numeroProcesso: 1, numeroProcessoFull: 1 } });
      if (!proc) continue;
      const { habilitado, config } = await E.configDoProcesso(db, proc);
      if (!habilitado) continue;
      const dias = (Date.now() - +new Date(s.enviadoEm || s.criadoEm)) / 864e5;
      const marcos = config.prazoCobrancaDias || [2, 4];
      if (s.lembretes < marcos.length && dias >= marcos[s.lembretes]) {
        const caixa = await E.carregarCaixa(db, proc.codigoEscritorio);
        const faltam = s.faltam?.length ? s.faltam : (s.itens || []).filter((i) => !i.recebido).map((i) => i.item);
        if (caixa && s.para?.length) {
          await E.enviarEmail(caixa, {
            para: s.para, cc: s.cc, inReplyTo: s.messageId,
            assunto: `Lembrete: ${s.assunto}`,
            corpo: `Prezados,\n\nReforçamos o pedido do processo ${proc.numeroProcessoFull || proc.numeroProcesso}. Ainda pendente(s):\n${faltam.map((f) => `- ${f}`).join('\n')}\n\nMantenha o código ${s.codigo} no assunto.\n`,
          });
          await db.collection('subsidiosSolicitacoes').updateOne({ _id: s._id }, { $inc: { lembretes: 1 }, $push: { eventos: { tipo: 'lembrete', em: new Date() } } });
        }
      }
      if (s.prazoContestacao && (+new Date(s.prazoContestacao) - Date.now()) / 864e5 <= 5 && !s.escalado) {
        await db.collection('analiseAlertas').insertOne({ codigoEscritorio: proc.codigoEscritorio, idProcesso: s.idProcesso, tipo: 'subsidio_prazo', texto: `Subsídios pendentes e prazo de contestação em ${new Date(s.prazoContestacao).toLocaleDateString('pt-BR')} (${proc.numeroProcessoFull || proc.numeroProcesso}).`, criadoEm: new Date(), lido: false });
        await db.collection('subsidiosSolicitacoes').updateOne({ _id: s._id }, { $set: { escalado: true } });
      }
    } catch (e) {
      log('lembrete erro', String(s._id), e.message);
    }
  }
}
