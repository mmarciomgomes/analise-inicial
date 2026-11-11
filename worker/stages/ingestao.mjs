// Etapa 2 — ingestão: texto por página (OCR quando precisa) e classificação das peças.
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaClassificacao } from '../lib/schemas.mjs';
import { E, textoDoDocumento, documentosDoProcesso } from '../lib/contexto.mjs';

const PAGINAS_POR_CHAMADA = 120;

export async function classificarDocumentos(ctx, textos) {
  const segmentos = [];
  for (const t of textos) {
    if (!t.paginas.length) continue;
    for (let i = 0; i < t.paginas.length; i += PAGINAS_POR_CHAMADA) {
      const lote = t.paginas.slice(i, i + PAGINAS_POR_CHAMADA);
      const listagem = lote.map((p) => `p.${p.pagina}: ${p.texto.slice(0, 260).replace(/\s+/g, ' ')}`).join('\n');
      const { dados } = await chamarEstruturado({
        sistema: ctx.pacote.prompts?.classificacao || 'Classifique as páginas do documento em peças.',
        usuario: `Documento docId=${t.docId} ("${t.nome}"), páginas ${lote[0].pagina} a ${lote.at(-1).pagina}.\nCada linha traz o início do texto da página. Agrupe páginas consecutivas da mesma peça e diga o tipo.\nToda página deve pertencer a um segmento.\n\n${listagem}`,
        nome: 'registrar_segmentos', descricao: 'Registra os segmentos (peças) do documento', schema: schemaClassificacao,
        registrarUso: ctx.registrarUso,
      });
      for (const s of dados.segmentos) {
        const ini = Math.max(lote[0].pagina, s.paginaInicial);
        const fim = Math.min(lote.at(-1).pagina, s.paginaFinal);
        if (fim >= ini) segmentos.push({ docId: t.docId, paginaInicial: ini, paginaFinal: fim, tipo: s.tipo, descricao: s.descricao || null });
      }
    }
  }
  return segmentos;
}

export async function executar(ctx) {
  const { db, processo, config } = ctx;
  await ctx.estado(E.ESTADOS.INGESTAO);
  const docs = await documentosDoProcesso(db, processo._id);
  if (!docs.length) throw new Error('Processo sem documentos anexados (suba a inicial com documentos).');

  const textos = [];
  const metas = [];
  for (const d of docs) {
    const t = await textoDoDocumento(db, d, { maxPaginas: config.limites?.paginasPorDocumento || 400 });
    textos.push({ ...t, nome: d.originalName });
    metas.push({ docId: String(d._id), nome: d.originalName, hash: t.hash, paginas: t.paginas.length, ocrPaginas: t.paginas.filter((p) => p.ocr).length, meta: t.meta });
  }
  const segmentos = await classificarDocumentos(ctx, textos);
  if (!segmentos.some((s) => s.tipo === 'peticao_inicial')) {
    // sem inicial identificada: usa o primeiro documento inteiro como inicial e avisa
    const t = textos.find((x) => x.paginas.length);
    if (t) segmentos.unshift({ docId: t.docId, paginaInicial: 1, paginaFinal: Math.min(t.paginas.length, 60), tipo: 'peticao_inicial', descricao: 'assumido (não identificado)' });
  }
  await ctx.salvar({ ingestao: { documentos: metas, segmentos, em: new Date() } });
  await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'extracao', prioridade: 3 });
  return { documentos: metas.length, segmentos: segmentos.length };
}
