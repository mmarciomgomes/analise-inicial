// Etapa 7 — parecer de defesa: lê os subsídios, reaplica as regras (prescrição, canal, estorno...) e redige.
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaLeituraSubsidios, schemaParecer, schemaDecisaoJudicial } from '../lib/schemas.mjs';
import { textoComMarcadores } from '../lib/docs.mjs';
import { E, D, textoDoDocumento, documentosDoProcesso } from '../lib/contexto.mjs';

const v = (x) => (x && typeof x === 'object' && 'valor' in x ? x.valor : x);

async function decisaoJudicial(ctx) {
  if (ctx.job.payload?.decisaoJudicial) return ctx.job.payload.decisaoJudicial;
  const { db, processo, analise } = ctx;
  const pubs = await db.collection('publicacoes').find({ $or: [{ idProcesso: processo._id }, { numeroProcesso: processo.numeroProcesso }] })
    .sort({ _id: -1 }).limit(6).toArray().catch(() => []);
  const textos = pubs.map((p) => p.texto || p.teor || p.conteudo || p.textoPublicacao || '').filter((t) => t.length > 40);
  if (!textos.length) return analise.triagem?.llm?.decisaoJudicialNaInicial || null;
  const { dados } = await chamarEstruturado({
    sistema: 'Você lê publicações de um processo e identifica se o juízo determinou a exibição/apresentação de documentos e se impôs sanção (multa, busca e apreensão, "sob as penas da lei" ou art. 400 do CPC).',
    usuario: textos.map((t, i) => `### Publicação ${i + 1}\n${t.slice(0, 6000)}`).join('\n\n'),
    nome: 'registrar_decisao', descricao: 'Registra a decisão judicial relevante', schema: schemaDecisaoJudicial, registrarUso: ctx.registrarUso,
  });
  return dados;
}

export async function executar(ctx) {
  const { db, processo, analise, pacote } = ctx;
  if (!ctx.modulo('parecer')) return { pulado: 'módulo parecer desligado' };
  const aprovada = analise.triagem?.aprovada;
  if (!aprovada) throw new Error('Triagem não aprovada.');
  await ctx.estado(E.ESTADOS.PARECER);

  const docs = await documentosDoProcesso(db, processo._id, { origem: 'subsidio' });
  const partes = [];
  for (const d of docs) {
    const t = await textoDoDocumento(db, d);
    partes.push({ docId: String(d._id), titulo: `${d.tipoSubsidio || 'subsídio'}: ${d.originalName}`, paginas: t.paginas });
  }
  const texto = textoComMarcadores(partes, 160000);
  const ficha = D.fichaPlana(analise.ficha || {});

  const { dados: leitura } = await chamarEstruturado({
    sistema: `${pacote.prompts?.subsidio || ''}\nUse [[doc:ID]] e [[p.N]] para indicar a origem. Datas no formato aaaa-mm-dd.`,
    usuario: `Contratos citados na inicial: ${JSON.stringify(ficha.contratos || [])}\nAutor: ${ficha.autor?.nome} (menor/incapaz: ${ficha.autor?.menorOuIncapaz ? 'sim' : 'não'}; representante: ${ficha.autor?.representante?.nome || '-'})\n\nSUBSÍDIOS:\n${texto || '(nenhum documento recebido)'}`,
    nome: 'registrar_leitura', descricao: 'Registra os dados lidos dos subsídios', schema: schemaLeituraSubsidios, registrarUso: ctx.registrarUso,
  });

  // sem tela do SAG não se conclui "não é cliente" (encontrado = null)
  const contratosSag = leitura.sag?.contratos || [];
  const sag = { contratos: contratosSag, encontrado: !leitura.sag?.consultado ? null : leitura.sag.encontrado === false ? false : contratosSag.length > 0 };
  const escolhido = D.escolherContrato(ficha, sag) || {};
  const contrato = {
    ...escolhido,
    canal: v(leitura.trilha?.canal) || escolhido.canal || null,
    contratadoPeloRepresentante: v(leitura.contrato?.contratadoPeloRepresentante) ?? null,
  };
  const decJud = await decisaoJudicial(ctx);
  const decisao = D.decidirParecer({ pacote, ficha: analise.ficha, triagemLLM: analise.triagem?.llm, diligencias: analise.diligencias, decisaoTriagem: aprovada, sag, contrato, decisaoJudicial: decJud || {}, hoje: new Date() });
  if (!leitura.sag?.consultado) decisao.alertas.push({ nivel: 'atencao', texto: 'Sem telas do SAG: prescrição e "não é cliente" não puderam ser avaliadas.', regra: 'parecer' });
  if (decisao.teses.some((t) => String(t.tese).startsWith('revisional')) && v(leitura.contrato?.taxaMensal)) {
    decisao.alertas.push({ nivel: 'info', texto: `Revisional: taxa contratada ${v(leitura.contrato.taxaMensal)}% a.m. — rodar o motor de cálculo contra a taxa média do Bacen da modalidade e do período.`, regra: 'parecer' });
  }

  const { dados: texto2, modelo } = await chamarEstruturado({
    sistema: `${pacote.prompts?.parecer || ''}\n\n=== MANUAL (${pacote.versao}) ===\n${pacote.manualTexto || ''}`,
    usuario: JSON.stringify({
      ficha: { autor: ficha.autor, contratos: ficha.contratos, fatos: ficha.fatos, pedidos: ficha.pedidos },
      diligencias: { conexao: analise.diligencias?.conexao, litispendencia: analise.diligencias?.litispendencia, coisaJulgada: analise.diligencias?.coisaJulgada, advogado: analise.diligencias?.advogado },
      leituraSubsidios: leitura,
      decisaoRegras: { teses: decisao.teses, preliminares: decisao.preliminares, poloPassivo: decisao.poloPassivo, prescricao: decisao.campos?.prescricao || null, juntar: decisao.juntar, naoJuntar: decisao.bloqueados, acordo: decisao.acordo, alertas: decisao.alertas, contrato },
      decisaoJudicial: decJud,
    }),
    nome: 'registrar_parecer', descricao: 'Registra o parecer de defesa', schema: schemaParecer, registrarUso: ctx.registrarUso,
  });

  // itens que o parecer descobriu que faltam (ex.: gravação da Toscana) => rascunho de complemento
  const recebidos = new Set((await db.collection('subsidiosSolicitacoes').find({ idProcesso: processo._id }).toArray())
    .flatMap((s) => (s.itens || []).filter((i) => i.recebido).map((i) => i.item)));
  const novosPedidos = (decisao.subsidios || []).map((s) => s.item).filter((i) => !recebidos.has(i));
  if (novosPedidos.length && ctx.modulo('subsidios')) {
    await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'subsidios', payload: { acao: 'complemento', itens: novosPedidos }, prioridade: 2, chave: 'subsidios:complemento' });
  }

  await ctx.salvar({ parecer: { leitura, decisao, decisaoJudicial: decJud, texto: texto2, modelo, em: new Date(), versaoManual: pacote.versao, aprovadoPor: null, aprovadoEm: null } });
  await ctx.estado(E.ESTADOS.AGUARDANDO_REVISAO_PARECER);
  return { teses: decisao.teses.length, prescricao: decisao.campos?.prescricao || null, complemento: novosPedidos.length };
}
