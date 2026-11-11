// Etapa 8 — minuta: montada por blocos aprovados do pacote; a LLM só escreve a síntese dos fatos.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaFatos } from '../lib/schemas.mjs';
import { enviarS3, S3_BUCKET } from '../lib/docs.mjs';
import { E, U, D, CONF } from '../lib/contexto.mjs';

const v = (x) => (x && typeof x === 'object' && 'valor' in x ? x.valor : x);
const fmtData = (d) => { const x = d ? new Date(d) : null; return x && !Number.isNaN(+x) ? x.toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : ''; };

// ordem das seções: abertura, fatos, preliminares (ordem da taxonomia), mérito (principais, depois subsidiárias), pedidos, fecho
export function montarSecoes({ pacote, decisao, vars }) {
  const blocos = pacote.blocos || {};
  const r = (k) => U.renderTemplate(blocos[k] || '', vars);
  const secoes = [{ titulo: null, texto: r('abertura') }, { titulo: 'DOS FATOS', texto: r('fatos') }];
  const ordemPrel = (pacote.taxonomia?.preliminares || []).map((p) => p.id);
  const prels = (decisao.preliminares || []).slice().sort((a, b) => ordemPrel.indexOf(a.preliminar) - ordemPrel.indexOf(b.preliminar));
  if (prels.length) secoes.push({ titulo: 'PRELIMINARES', texto: null });
  for (const p of prels) secoes.push({ titulo: D.nomePreliminar(pacote, p.preliminar).toUpperCase(), sub: true, texto: blocos[`preliminar.${p.preliminar}`] ? r(`preliminar.${p.preliminar}`) : `[BLOCO AUSENTE NO PACOTE: preliminar.${p.preliminar}] — ${p.motivo}` });
  secoes.push({ titulo: 'DO MÉRITO', texto: null });
  const teses = (decisao.teses || []).slice().sort((a, b) => (a.papel === b.papel ? 0 : a.papel === 'principal' ? -1 : 1));
  for (const t of teses) {
    const chave = blocos[`merito.${t.tese}`] ? `merito.${t.tese}` : 'merito.*';
    const texto = U.renderTemplate(blocos[chave] || '', { ...vars, teseNome: D.nomeTese(pacote, t.tese) });
    secoes.push({ titulo: `${D.nomeTese(pacote, t.tese).toUpperCase()}${t.papel === 'subsidiaria' ? ' (SUBSIDIARIAMENTE)' : ''}`, sub: true, texto });
  }
  secoes.push({ titulo: 'DOS PEDIDOS', texto: r('pedidos') });
  secoes.push({ titulo: null, texto: r('fecho') });
  return secoes;
}

function paragrafos(texto) {
  return String(texto || '').split(/\n{2,}|\n/).filter((l) => l.trim()).map((l) => new Paragraph({
    children: [new TextRun({ text: l.trim(), font: 'Times New Roman', size: 24 })],
    alignment: AlignmentType.JUSTIFIED, spacing: { after: 160, line: 360 }, indent: { firstLine: 1134 },
  }));
}

const titulo = (texto, sub) => new Paragraph({
  children: [new TextRun({ text: texto, bold: true, font: 'Times New Roman', size: 24, color: '000000' })],
  heading: sub ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
  alignment: sub ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { before: 280, after: 140 },
});
const item = (texto, negrito = false) => new Paragraph({ children: [new TextRun({ text: texto, bold: negrito, font: 'Times New Roman', size: 22 })], spacing: { after: 80 } });

export async function gerarDocx({ cabecalho, secoes, anexos, avisos }) {
  const children = [];
  children.push(new Paragraph({ children: [new TextRun({ text: cabecalho, bold: true, font: 'Times New Roman', size: 24 })], spacing: { after: 480 } }));
  for (const s of secoes) {
    if (s.titulo) children.push(titulo(s.titulo, s.sub));
    if (s.texto) children.push(...paragrafos(s.texto));
  }
  if (anexos.juntar.length || anexos.bloqueados.length) children.push(titulo('ANEXOS SUGERIDOS (conferir antes de protocolar)'));
  for (const a of anexos.juntar) children.push(item(`• JUNTAR: ${a.documento} — ${a.motivo}`));
  for (const a of anexos.bloqueados) children.push(item(`• NÃO JUNTAR: ${a.documento} — ${a.motivo}${a.providencia ? ` ${a.providencia}` : ''}`, true));
  if (avisos.length) {
    children.push(titulo('PONTOS DE ATENÇÃO DA ANÁLISE (apagar antes de protocolar)'));
    for (const a of avisos) children.push(item(`• ${a}`));
  }
  const doc = new Document({ creator: 'Gomjur — Análise Inicial', title: 'Minuta de contestação', sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function executar(ctx) {
  const { db, processo, analise, pacote } = ctx;
  if (!ctx.modulo('minuta')) return { pulado: 'módulo minuta desligado' };
  const parecer = analise.parecer;
  if (!parecer?.aprovadoEm) throw new Error('Parecer não aprovado.');
  await ctx.estado(E.ESTADOS.MINUTA);
  const dec = parecer.decisao;
  const ficha = D.fichaPlana(analise.ficha || {});

  const { dados: fatos } = await chamarEstruturado({
    sistema: pacote.prompts?.fatos || 'Redija a síntese dos fatos.',
    usuario: JSON.stringify({ inicial: { autor: ficha.autor?.nome, contratos: ficha.contratos, fatos: ficha.fatos, pedidos: ficha.pedidos }, subsidios: parecer.leitura, conclusao: parecer.texto?.resumo }),
    nome: 'registrar_fatos', descricao: 'Síntese dos fatos', schema: schemaFatos, registrarUso: ctx.registrarUso,
  });

  const adv = ctx.job.payload?.advogado || {};
  const polo = dec.poloPassivo || {};
  const c = dec.contrato || {};
  const vars = {
    reuNome: polo.empresa || (ficha.poloPassivo || [])[0]?.nome || '', reuCnpj: polo.cnpj || (ficha.poloPassivo || [])[0]?.cnpj || '',
    autor: ficha.autor?.nome || processo.ativo?.nome || '', numeroProcesso: processo.numeroProcessoFull || processo.numeroProcesso,
    sinteseFatos: fatos.sinteseFatos,
    processosConexos: (analise.diligencias?.conexao || []).map((x) => x.numero).join(', '),
    processosLitispendencia: (analise.diligencias?.litispendencia || []).map((x) => x.numero).join(', '),
    processosCoisaJulgada: (analise.diligencias?.coisaJulgada || []).map((x) => x.numero).join(', '),
    poloCorretoNome: polo.empresa || '', poloCorretoCnpj: polo.cnpj || '',
    contratoNumero: c.numero || '', contratoDataCelebracao: fmtData(c.dataCelebracao), contratoUltimoPagamento: fmtData(c.ultimoPagamento),
    cidade: adv.cidade || processo.comarca || '', data: new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }),
    advogadoNome: adv.nome || '[ADVOGADO]', advogadoOab: adv.oab || '[OAB]',
  };
  const secoes = montarSecoes({ pacote, decisao: dec, vars });
  const avisos = [
    ...(dec.alertas || []).filter((a) => a.nivel !== 'info').map((a) => a.texto),
    ...(parecer.texto?.pendencias || []),
    ...(secoes.filter((s) => /\[BLOCO/.test(s.texto || '')).length ? ['Há blocos provisórios ou ausentes: substituir pelos textos aprovados do escritório.'] : []),
  ];
  const cabecalhoPeca = `EXCELENTÍSSIMO(A) SENHOR(A) DOUTOR(A) JUIZ(A) — ${v(analise.ficha?.processo?.juizo) || processo.comarca || ''}`.toUpperCase();
  const buf = await gerarDocx({
    cabecalho: cabecalhoPeca,
    secoes, anexos: { juntar: dec.juntar || [], bloqueados: dec.bloqueados || [] }, avisos,
  });

  // conferência automática (modo rascunho: realce vira alerta; a conferência para protocolo é feita na peça final)
  let conferencia = null;
  try {
    // confere só o texto da peça (sem as seções internas de anexos e avisos, que o advogado apaga)
    const soPeca = await gerarDocx({ cabecalho: cabecalhoPeca, secoes, anexos: { juntar: [], bloqueados: [] }, avisos: [] });
    const rc = await CONF.conferirDocx(soPeca, { modo: 'rascunho', config: pacote.conferencia, dados: CONF.dadosParaConferencia({ processo, analise, pacote }) });
    conferencia = { ok: rc.ok, resumo: rc.resumo, achados: rc.achados.filter((a) => a.severidade !== 'info').slice(0, 100), versao: rc.versao };
    if (!rc.ok) avisos.push(`Conferência: ${rc.resumo.bloqueios} ponto(s) a resolver antes de protocolar (lacunas, variáveis ou instruções no texto).`);
  } catch (e) {
    conferencia = { erro: e.message };
  }

  const nome = `Minuta-contestacao-${U.soDigitos(vars.numeroProcesso)}-${Date.now()}.docx`;
  const key = `${processo.codigoEscritorio.toHexString()}/analise/${processo._id.toHexString()}/${nome}`;
  await enviarS3(S3_BUCKET, key, buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const ins = await db.collection('documentosAnexados').insertOne({
    idProcesso: processo._id, codigoEscritorio: processo.codigoEscritorio, numeroProcesso: processo.numeroProcesso,
    folderId: null, folderPathSegments: [], descricao: 'Minuta de contestação (Análise da Inicial) — revisar antes de protocolar',
    s3Key: key, storedName: key, originalName: nome, size: buf.length, bucket: S3_BUCKET, origem: 'analise-minuta',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', cadastradoEm: new Date(), uploadedAt: new Date(), criadoPor: 'analise',
  });
  await ctx.salvar({ minuta: { docId: ins.insertedId, nome, em: new Date(), avisos, conferencia, blocosProvisorios: secoes.filter((s) => /\[BLOCO/.test(s.texto || '')).length } });
  await ctx.estado(E.ESTADOS.MINUTA_PRONTA);
  return { docId: String(ins.insertedId) };
}
