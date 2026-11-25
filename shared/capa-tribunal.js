// shared/capa-tribunal.js — capa do processo na buscaprocessos (a mesma consulta da conferência de capa do processo).
// A análise roda como serviço próprio (sem o jur.js), por isso a leitura do PDF está aqui: o parser é o de
// server/jur/conferencia-capa.js (parseCapaTexto). Se o layout da fonte mudar, ajuste os dois.
'use strict';

const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const BASE_URL = String(process.env.BUSCAPROCESSOS_URL || 'https://buscaprocessos.app.br/consulta').trim();
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

function formatarCNJ(digits) {
  const d = onlyDigits(digits);
  if (d.length !== 20) return '';
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d[13]}.${d.slice(14, 16)}.${d.slice(16)}`;
}

async function fetchCapaPdf(numeroProcesso) {
  const cnj = formatarCNJ(numeroProcesso);
  if (!cnj) throw new Error('Número do processo fora do padrão CNJ (20 dígitos).');
  const r = await fetch(`${BASE_URL}?numeroProcesso=${encodeURIComponent(cnj)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Gomjur/1.0)', accept: 'application/pdf,*/*' },
    signal: AbortSignal.timeout(30000),
  });
  const tipo = String(r.headers.get('content-type') || '');
  if (r.status !== 200) throw new Error(`buscaprocessos respondeu HTTP ${r.status}.`);
  if (!/pdf/i.test(tipo)) throw new Error(`buscaprocessos devolveu ${tipo || 'conteúdo desconhecido'} em vez de PDF.`);
  return Buffer.from(await r.arrayBuffer());
}

const ROTULOS = [
  'VALOR DA CAUSA', 'MOVIMENTAÇÕES', 'ANO DE INÍCIO', 'GRAU', 'PARTES PRINCIPAIS', 'POLO ATIVO', 'POLO PASSIVO',
  'LINHA DO TEMPO', 'Distribuição', 'Últ. Movimentação', 'Últ. Verificação', 'DETALHES DO PROCESSO', 'ASSUNTO',
  'ÁREA', 'TRIBUNAL', 'ÓRGÃO JULGADOR', 'SITUAÇÃO', 'FONTES ARQUIVADAS?',
];

function parseMoneyBR(s) {
  const m = String(s || '').match(/R\$\s*([\d.]+,\d{2})/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function dataBR(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// Retorna null se não reconhecer o layout.
function parseCapaTexto(texto) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!linhas.some((l) => /^Processo n[ºo°]/i.test(l))) return null;
  const idx = (rot) => linhas.findIndex((l) => l === rot);
  const bloco = (rot) => {
    const i = idx(rot);
    if (i < 0) return '';
    const out = [];
    for (let j = i + 1; j < linhas.length; j++) {
      if (ROTULOS.includes(linhas[j]) || /^ENVOLVIDOS/.test(linhas[j]) || /^Fonte:/.test(linhas[j])) break;
      out.push(linhas[j]);
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };
  const cab = linhas.findIndex((l) => /^Processo n[ºo°]/i.test(l));
  const partesResumo = (linhas[cab + 2] || '').split('·').map((s) => s.trim());
  const out = {
    numeroProcesso: onlyDigits(linhas[cab]),
    situacao: bloco('SITUAÇÃO') || (linhas[cab + 1] || '').replace(/Base Oficial.*/i, '').trim(),
    tipoProcedimento: partesResumo[0] || '',
    tribunalSigla: partesResumo[1] || '',
    orgaoJulgador: bloco('ÓRGÃO JULGADOR') || partesResumo[2] || '',
    valorCausa: parseMoneyBR(bloco('VALOR DA CAUSA')),
    poloAtivo: bloco('POLO ATIVO'),
    poloPassivo: bloco('POLO PASSIVO'),
    dataDistribuicao: dataBR(bloco('Distribuição')),
    assunto: bloco('ASSUNTO'),
    tribunal: bloco('TRIBUNAL'),
  };
  const uteis = [out.valorCausa != null, out.orgaoJulgador, out.poloAtivo, out.poloPassivo, out.assunto, out.dataDistribuicao].filter(Boolean).length;
  return uteis >= 2 ? out : null;
}

async function consultarCapa(numeroProcesso) {
  const { text } = await pdfParse(await fetchCapaPdf(numeroProcesso));
  const capa = parseCapaTexto(text);
  if (!capa) throw new Error('Não foi possível ler a capa no PDF (layout não reconhecido ou processo sem dados).');
  if (capa.numeroProcesso && capa.numeroProcesso !== onlyDigits(numeroProcesso)) throw new Error('A consulta devolveu outro número de processo.');
  return capa;
}

module.exports = { consultarCapa, parseCapaTexto, formatarCNJ };
