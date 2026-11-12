// Etapa 6 — subsídios: monta o pedido (texto + checklist) que o advogado sobe no sistema do cliente, lê o que o cliente
// devolveu (arquivos anexados manualmente ao processo) e avisa quando o retorno demora. Não há e-mail.
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

function dadosModelo(ctx, extra = {}) {
  const { processo, analise, escritorio } = ctx;
  const f = analise.ficha || {};
  const dec = analise.triagem?.aprovada || {};
  return {
    numeroProcesso: processo.numeroProcessoFull || processo.numeroProcesso,
    pasta: processo.novaPasta || '',
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
  const { db, processo, pacote } = ctx;
  const modelo = (pacote.pedidos || pacote.emails)?.[tipo];
  if (!modelo) throw new Error(`Modelo de pedido "${tipo}" não existe no pacote.`);
  const prazo = await prazoContestacao(db, processo);
  const dados = dadosModelo(ctx, { itens: itens.map((i) => ({ item: i })), prazo: prazo ? prazo.toLocaleDateString('pt-BR') : 'a confirmar', ...extra });
  const doc = {
    tipo, codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id,
    assunto: U.renderTemplate(modelo.assunto, dados), corpo: U.renderTemplate(modelo.corpo, dados),
    itens: itens.map((i) => ({ item: i, recebido: false, docs: [] })), status: 'a_enviar', prazoContestacao: prazo,
    lembretes: 0, eventos: [{ tipo: 'criado', em: new Date() }], criadoEm: new Date(),
  };
  await db.collection('subsidiosSolicitacoes').insertOne(doc);
  return doc;
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
  await ctx.estado(E.ESTADOS.SUBSIDIOS_RASCUNHO);
  return { solicitacoes: criadas.length };
}

// o advogado anexou o que o cliente devolveu: lê, marca o checklist; tudo recebido => parecer
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

// rotina periódica: avisa na tela quando o retorno do cliente demora (D+2/D+4) e perto do prazo de contestação
export async function lembretes(db, log) {
  const abertas = await db.collection('subsidiosSolicitacoes').find({ status: { $in: ['enviado', 'parcial'] }, tipo: { $in: ['subsidio', 'complemento'] } }).limit(500).toArray();
  for (const s of abertas) {
    try {
      const proc = await db.collection('processos').findOne({ _id: s.idProcesso }, { projection: { codigoEscritorio: 1, idCliente: 1, clienteId: 1, numeroProcesso: 1, numeroProcessoFull: 1, novaPasta: 1 } });
      if (!proc) continue;
      const { habilitado, config } = await E.configDoProcesso(db, proc);
      if (!habilitado) continue;
      const ref = `${proc.novaPasta ? `Pasta ${proc.novaPasta} — ` : ''}${proc.numeroProcessoFull || proc.numeroProcesso}`;
      const dias = (Date.now() - +new Date(s.enviadoEm || s.criadoEm)) / 864e5;
      const marcos = config.prazoCobrancaDias || [2, 4];
      if (s.lembretes < marcos.length && dias >= marcos[s.lembretes]) {
        const faltam = s.faltam?.length ? s.faltam : (s.itens || []).filter((i) => !i.recebido).map((i) => i.item);
        await db.collection('analiseAlertas').insertOne({ codigoEscritorio: proc.codigoEscritorio, idProcesso: s.idProcesso, tipo: 'subsidio_sem_retorno', texto: `Sem retorno do cliente há ${Math.floor(dias)} dia(s) (${ref}). Consulte o sistema do cliente. Pendente(s): ${faltam.join('; ')}.`, criadoEm: new Date(), lido: false });
        await db.collection('subsidiosSolicitacoes').updateOne({ _id: s._id }, { $inc: { lembretes: 1 }, $push: { eventos: { tipo: 'lembrete', em: new Date() } } });
      }
      if (s.prazoContestacao && (+new Date(s.prazoContestacao) - Date.now()) / 864e5 <= 5 && !s.escalado) {
        await db.collection('analiseAlertas').insertOne({ codigoEscritorio: proc.codigoEscritorio, idProcesso: s.idProcesso, tipo: 'subsidio_prazo', texto: `Subsídios pendentes e prazo de contestação em ${new Date(s.prazoContestacao).toLocaleDateString('pt-BR')} (${ref}).`, criadoEm: new Date(), lido: false });
        await db.collection('subsidiosSolicitacoes').updateOne({ _id: s._id }, { $set: { escalado: true } });
      }
    } catch (e) {
      log('lembrete erro', String(s._id), e.message);
    }
  }
}
