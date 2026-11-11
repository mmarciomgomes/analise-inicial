// Etapa 5 — triagem: LLM enquadra o núcleo (taxonomia fechada) + regras do pacote decidem.
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaTriagem } from '../lib/schemas.mjs';
import { textoComMarcadores } from '../lib/docs.mjs';
import { E, D, paginasDoSegmento } from '../lib/contexto.mjs';

export async function leituraLLM(ctx) {
  const { db, analise, pacote } = ctx;
  const segs = (analise.ingestao?.segmentos || []).filter((s) => s.tipo === 'peticao_inicial');
  const partes = [];
  for (const s of segs) partes.push({ docId: s.docId, titulo: 'PETIÇÃO INICIAL', paginas: await paginasDoSegmento(db, s) });
  const texto = textoComMarcadores(partes, 90000);
  const tax = pacote.taxonomia || {};
  const ids = (tax.teses || []).map((t) => t.id);
  const ficha = D.fichaPlana(analise.ficha || {});
  const dil = analise.diligencias || {};
  const { dados, modelo } = await chamarEstruturado({
    sistema: `${pacote.prompts?.triagem || ''}\n\n=== MANUAL (${pacote.versao}) ===\n${pacote.manualTexto || ''}`,
    usuario: [
      `TAXONOMIA DE TESES (use apenas estes ids):\n${(tax.teses || []).map((t) => `- ${t.id}: ${t.nome} (manual ${t.manual})`).join('\n')}`,
      `PRODUTOS: ${(tax.produtos || []).join(', ')}`,
      `FICHA DA INICIAL (já extraída):\n${JSON.stringify({ autor: ficha.autor, poloPassivo: ficha.poloPassivo, contratos: ficha.contratos, fatos: ficha.fatos, pedidos: ficha.pedidos, processo: ficha.processo })}`,
      `DILIGÊNCIAS: conexão=${(dil.conexao || []).length}, litispendência=${(dil.litispendencia || []).length}, coisa julgada=${(dil.coisaJulgada || []).length}, advogado=${dil.advogado?.faixa || 'n/d'}`,
      `PETIÇÃO INICIAL:\n${texto}`,
      'Enquadre a tese principal pelo fato central (cap. 14 e 15). Se a fraude depende do canal (trilha), use "fraude" genérico.',
    ].join('\n\n'),
    nome: 'registrar_triagem', descricao: 'Registra o enquadramento do caso', schema: schemaTriagem(ids, tax.produtos || []),
    registrarUso: ctx.registrarUso,
  });
  return { ...dados, modelo };
}

export function decidir(ctx, triagemLLM) {
  const { analise, pacote, config } = ctx;
  const diligencias = analise.diligencias || {};
  const dec = D.decidirTriagem({ pacote, ficha: analise.ficha, triagemLLM, diligencias, hoje: new Date() });
  dec.alertas.push(...(diligencias.alertas || []).map((a) => ({ ...a, regra: a.regra || 'diligencias' })));
  dec.precisaRevisao = D.precisaRevisao(dec, triagemLLM, config.revisao);
  return dec;
}

export async function executar(ctx) {
  const { db, processo, config, analise } = ctx;
  const jaAprovada = !!analise.triagem?.aprovada;
  if (!jaAprovada) await ctx.estado(E.ESTADOS.TRIAGEM);
  const triagemLLM = ctx.job.payload?.somenteRegras && analise.triagem?.llm ? analise.triagem.llm : await leituraLLM(ctx);
  const decisao = decidir(ctx, triagemLLM);

  await ctx.salvar({ triagem: { ...(analise.triagem || {}), llm: triagemLLM, decisao, em: new Date(), versaoManual: ctx.pacote.versao } });

  if (jaAprovada) {
    // nova informação (ex.: jus.br) depois da aprovação: só avisa o que mudou
    const antes = new Set((analise.triagem.aprovada.preliminares || []).map((p) => p.preliminar));
    const novas = decisao.preliminares.filter((p) => !antes.has(p.preliminar));
    if (novas.length) {
      await ctx.salvar({}, { $push: { avisos: { em: new Date(), texto: `Novas preliminares após a aprovação: ${novas.map((n) => n.preliminar).join(', ')}.` } } });
    }
    return { reprocessada: true, novasPreliminares: novas.length };
  }

  const automatico = config.revisao?.modo === 'automatico' && !decisao.precisaRevisao.obrigatoria;
  if (automatico && ctx.modulo('subsidios')) {
    await ctx.salvar({ 'triagem.aprovada': decisao, 'triagem.aprovadaPor': null, 'triagem.aprovadaEm': new Date(), 'triagem.aprovacaoAutomatica': true });
    await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'subsidios', payload: { acao: 'rascunho', autoEnviar: true }, prioridade: 2 });
  } else {
    await ctx.estado(E.ESTADOS.AGUARDANDO_REVISAO_TRIAGEM, { motivosRevisao: decisao.precisaRevisao.motivos });
  }
  return { teses: decisao.teses.length, automatico };
}
