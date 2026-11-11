// shared/conferencia.js — conferência de peças (.docx e .pdf) antes de liberar/protocolar.
//
// Procura o que não pode chegar ao juiz: variáveis e lacunas não preenchidas (VAR_, XXXX, [ADVOGADO]),
// instruções internas dos modelos ("(APENAS QUANDO…)", "CONFIRMAR SE…"), realce, texto em vermelho,
// comentários e alterações controladas; e, quando recebe os dados do processo, confere número do processo,
// parte, CNPJ da empresa do polo, contratos citados e se cada pedido da inicial foi impugnado.
//
// Uso:
//   const C = require('./conferencia');
//   const r = await C.conferirArquivo(buffer, { modo: 'protocolo', dados, config });   // .docx ou .pdf (pelo conteúdo)
//   dados (todos opcionais): { numeroProcesso, numerosProcesso[], partes[], parteAdversa, cnpjPolo, cnpjsGrupo[], contratos[], pedidos[] }
//   r.ok / r.resumo / r.achados
//   const anotado = await C.anotarDocx(buffer, r.achados);   // cópia com comentários do Word
//
// Dependências: jszip para .docx (o jur.js já tem via mammoth; o worker, via docx-templates);
// pdf-parse ou pdfjs-dist para .pdf (PDF não tem realce/cor: confere só o texto). Arquivo único, CommonJS,
// copiável para qualquer projeto (jur.js, worker de análise, worker de protocolo).
'use strict';

const SEV = { BLOQUEIO: 'bloqueio', ALERTA: 'alerta', INFO: 'info' };
const VERSAO = '1.0.0';

/* ------------------------------------------------------------------ */
/* jszip                                                               */
/* ------------------------------------------------------------------ */
function carregarJSZip(injetado) {
  if (injetado) return injetado;
  const tentar = (id) => { try { const m = require(id); return typeof m?.loadAsync === 'function' ? m : null; } catch { return null; } };
  const z = tentar('jszip') || (process.env.JSZIP_PATH && tentar(process.env.JSZIP_PATH));
  if (!z) throw new Error('jszip não encontrado (npm i jszip).');
  return z;
}

/* ------------------------------------------------------------------ */
/* XML → parágrafos                                                    */
/* ------------------------------------------------------------------ */
const RE_PARAGRAFO = /<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
const RE_RUN = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;

function decodificar(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function escaparXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textoDoRun(inner) {
  let t = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<w:noBreakHyphen\/>/g;
  let m;
  while ((m = re.exec(inner))) {
    if (m[0].startsWith('<w:tab')) t += '\t';
    else if (m[0].startsWith('<w:br') || m[0].startsWith('<w:cr')) t += '\n';
    else if (m[0].startsWith('<w:noBreakHyphen')) t += '-';
    else if (m[1] != null) t += decodificar(m[1]);
  }
  return t;
}

function ehVermelho(hex) {
  if (!/^[0-9a-f]{6}$/i.test(hex || '')) return false;
  const r = parseInt(hex.slice(0, 2), 16); const g = parseInt(hex.slice(2, 4), 16); const b = parseInt(hex.slice(4, 6), 16);
  return r >= 0xb0 && g <= 0x50 && b <= 0x50;
}

function formatoDoRun(inner) {
  const rPr = (inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
  const hl = (rPr.match(/<w:highlight w:val="([^"]+)"/) || [])[1];
  const shd = (rPr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1];
  const cor = (rPr.match(/<w:color\b[^>]*w:val="([0-9A-Fa-f]{6})"/) || [])[1];
  const destaque = (hl && hl !== 'none') ? hl : (shd && !/^(ffffff|auto)$/i.test(shd) ? `#${shd}` : null);
  const negrito = /<w:b\/>|<w:b w:val="(?:1|true|on)"\/>/.test(rPr);
  return { destaque, vermelho: ehVermelho(cor), negrito, deletado: /<w:delText/.test(inner) };
}

// devolve [{ i, texto, estilo, runs:[{texto, destaque, vermelho, negrito}] }] para cada <w:p> (índice = ordem no XML)
function paragrafosDoXml(xml) {
  const out = [];
  let m; let i = 0;
  RE_PARAGRAFO.lastIndex = 0;
  while ((m = RE_PARAGRAFO.exec(xml))) {
    const corpo = m[1] || '';
    const estilo = (corpo.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
    const runs = [];
    let r;
    RE_RUN.lastIndex = 0;
    while ((r = RE_RUN.exec(corpo))) {
      const f = formatoDoRun(r[1]);
      if (f.deletado) continue;
      const texto = textoDoRun(r[1]);
      if (texto) runs.push({ texto, ...f });
    }
    out.push({ i, texto: runs.map((x) => x.texto).join(''), estilo, runs });
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Regras                                                              */
/* ------------------------------------------------------------------ */
const PALAVRAS_INSTRUCAO = [
  'APENAS', 'CONFIRM', 'VERIFIC', 'SEMPRE CONFIRM', 'SEMPRE SER', 'QUANDO (?:TIVER|HOUVER|FOR|A PARTE|O PROCESSO|REALMENTE)',
  'SOLICITAR', 'ADEQUAR', 'N[ÃA]O ESQUECER', 'INSERIR', 'COLOCAR', 'JUNTAR (?:O|A|OS|AS) ', 'ATEN[ÇC][ÃA]O ?:', 'OBS(?:ERVA[ÇC][ÃA]O)? ?:',
  'PR[ÓO]XIMO QUE PEGAR', 'FALAR COM', 'CASO (?:SEJA|TENHA|HAJA|A PARTE|O CLIENTE)', 'SE FOR (?:O )?CASO', 'SE HOUVER', 'SE A PARTE',
  'EXCLUIR', 'RETIRAR', 'MANTER APENAS', 'ESCOLHER', 'UTILIZAR (?:ESTE|ESSE)', 'USAR (?:ESTE|ESSE)', 'PREENCHER', 'ALTERAR', 'SUBSTITUIR',
];
const RE_INICIO_INSTRUCAO = new RegExp(`^(?:${PALAVRAS_INSTRUCAO.join('|')})`);

function proporcaoMaiusculas(s) {
  const letras = String(s).match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || [];
  if (letras.length < 4) return 0;
  const mai = letras.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return mai / letras.length;
}

const limparInicio = (s) => String(s).replace(/^[\s\-–—•*·>]+/, '').trim();

function ehInstrucao(texto, minMaiusculas) {
  const t = limparInicio(texto);
  return RE_INICIO_INSTRUCAO.test(t) && proporcaoMaiusculas(t) >= minMaiusculas;
}

// Regras de texto: { id, severidade, mensagem, achar(texto) => [{ trecho, inicio }] }
function regrasDeTexto(cfg) {
  const regex = (re) => (texto) => {
    const out = []; let m;
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    while ((m = r.exec(texto))) { out.push({ trecho: m[0], inicio: m.index }); if (!m[0].length) r.lastIndex++; }
    return out;
  };
  const base = [
    { id: 'variavel', severidade: SEV.BLOQUEIO, mensagem: 'Variável do modelo não substituída',
      achar: regex(/\bVAR_[A-Z0-9_]+|\{\{[^{}]{1,80}\}\}|\{[#/][^{}]{1,80}\}/g) },
    { id: 'lacuna', severidade: SEV.BLOQUEIO, mensagem: 'Lacuna não preenchida (XXXX)',
      achar: regex(/(?<![A-Za-zÀ-ÿ])[Xx]{4,}(?![A-Za-zÀ-ÿ])|\b(?:\d{1,2}|XX)\/XX\/(?:\d{2,4}|(?:20)?XX)\b|R\$\s*[Xx]{2,}\b|\b[Xx]{2,}\s?%/g) },
    { id: 'marcador', severidade: SEV.BLOQUEIO, mensagem: 'Marcador entre colchetes não resolvido',
      achar: regex(/\[(?=[^\]]*[A-ZÀ-Ý]{3})[A-ZÀ-Ý0-9][A-ZÀ-Ý0-9 _\-:.,/()ºª]{2,80}\]|\[(?:BLOCO|REVISAR|INSERIR|PREENCHER|COMPLETAR|PENDENTE)\b[^\]]{0,300}\]/g) },
    { id: 'instrucao', severidade: SEV.BLOQUEIO, mensagem: 'Instrução interna do modelo no texto',
      achar: (texto) => {
        const out = []; const re = /\(([^()]{3,400})\)/g; let m;
        while ((m = re.exec(texto))) if (ehInstrucao(m[1], cfg.minMaiusculas)) out.push({ trecho: m[0], inicio: m.index });
        // parágrafo inteiro que é instrução (sem parênteses), ex.: "APENAS QUANDO A PARTE TIVER NEGATIVADA…"
        if (!out.length && texto.length <= 600 && ehInstrucao(texto, Math.max(cfg.minMaiusculas, 0.8))) out.push({ trecho: texto.trim(), inicio: 0 });
        return out;
      } },
    { id: 'notaInterna', severidade: SEV.BLOQUEIO, mensagem: 'Recado interno da equipe no texto',
      achar: (texto) => [
        ...regex(/falar comigo|n[ãa]o esquecer de|modelo antigo|ver com (?:o|a) (?:dr|dra|coordena)/gi)(texto),
        ...regex(/\bN[ÃA]O JUNTAR\b/g)(texto),
        ...regex(/(?:apagar|conferir|retirar|excluir) antes de protocolar/gi)(texto),
      ] },
    { id: 'pluralAberto', severidade: SEV.INFO, mensagem: 'Singular/plural em aberto, ex.: "o(s) contrato(s)"', agregar: true,
      achar: regex(/[A-Za-zÀ-ÿ]+\((?:s|es|is|ão|ões|m|ns|a|as)\)/g) },
    { id: 'linhaEmBranco', severidade: SEV.ALERTA, mensagem: 'Linha para preencher (_____)',
      achar: regex(/_{6,}/g) },
  ];
  const extras = (cfg.regrasExtras || []).map((x) => ({
    id: x.id, severidade: x.severidade || SEV.ALERTA, mensagem: x.mensagem || x.id, agregar: !!x.agregar,
    achar: regex(new RegExp(x.padrao, x.flags || 'gi')),
  }));
  const desligadas = new Set(cfg.desligar || []);
  return [...base, ...extras].filter((r) => !desligadas.has(r.id));
}

const CONFIG_PADRAO = {
  minMaiusculas: 0.7,
  maxAchadosPorRegra: 200,
  // mapa de pedido (código da ficha) -> expressão que indica que a peça impugna esse pedido
  pedidos: {},
  regrasExtras: [],
  desligar: [],
};

/* ------------------------------------------------------------------ */
/* Utilidades de coerência                                             */
/* ------------------------------------------------------------------ */
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

function trechoEm(texto, inicio, tamanho, folga = 60) {
  const a = Math.max(0, inicio - folga); const b = Math.min(texto.length, inicio + tamanho + folga);
  return `${a > 0 ? '…' : ''}${texto.slice(a, b).replace(/\s+/g, ' ').trim()}${b < texto.length ? '…' : ''}`;
}

function pareceTitulo(p) {
  const t = p.texto.trim();
  if (!t || t.length > 220) return false;
  if (/heading|t[íi]tulo|ttulo|title/i.test(p.estilo)) return true;
  if (p.pdf) return t.length <= 160 && proporcaoMaiusculas(t) >= 0.9 && !/[;,.]$/.test(t);
  return proporcaoMaiusculas(t) >= 0.9 && !/[;,]$/.test(t) && p.runs.some((r) => r.negrito);
}

/* ------------------------------------------------------------------ */
/* Conferência                                                         */
/* ------------------------------------------------------------------ */
async function abrir(buffer, JSZipInjetado) {
  const JSZip = carregarJSZip(JSZipInjetado);
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('Arquivo não é um .docx válido (word/document.xml ausente).');
  return { zip, JSZip, documentXml: await doc.async('string') };
}

// Núcleo comum a .docx e .pdf: partes = [{ parte, arquivo, paras: [{ i, texto, runs, estilo, pagina? }] }]
function conferirBlocos({ partes, modo, cfg, dados, extras = [], meta = {} }) {
  const regras = regrasDeTexto(cfg);
  const achados = [];
  const contagem = {};
  const add = (a) => {
    contagem[a.regra] = (contagem[a.regra] || 0) + 1;
    if (contagem[a.regra] <= cfg.maxAchadosPorRegra) achados.push(a);
  };
  const agregadas = {};
  let textoCorpo = '';
  const paragrafosCorpo = [];

  for (const parte of partes) {
    let secao = null; let n = 0;
    for (const p of parte.paras) {
      if (!p.texto.trim()) continue;
      n++;
      if (parte.parte === 'corpo') { textoCorpo += `${p.texto}\n`; paragrafosCorpo.push(p); }
      if (parte.parte === 'corpo' && pareceTitulo(p) && !ehInstrucao(p.texto, 0.8)) secao = p.texto.trim().slice(0, 90);
      const local = { parte: parte.parte, paragrafo: n, xmlIndice: p.i, arquivo: parte.arquivo, secao, ...(p.pagina ? { pagina: p.pagina } : {}) };

      for (const regra of regras) {
        const hits = regra.achar(p.texto);
        if (!hits.length) continue;
        if (regra.agregar) {
          const ag = agregadas[regra.id] || (agregadas[regra.id] = { regra, total: 0, exemplos: [] });
          ag.total += hits.length;
          if (ag.exemplos.length < 5) ag.exemplos.push(hits[0].trecho);
          continue;
        }
        for (const h of hits) {
          add({ regra: regra.id, severidade: regra.severidade, mensagem: regra.mensagem, local, valor: h.trecho.slice(0, 300), trecho: trechoEm(p.texto, h.inicio, h.trecho.length) });
        }
      }

      // formatação (só .docx): realce e vermelho, um achado por parágrafo
      const realcado = (p.runs || []).filter((r) => r.destaque).map((r) => r.texto).join('').trim();
      if (realcado) {
        add({ regra: 'destaque', severidade: modo === 'protocolo' ? SEV.BLOQUEIO : SEV.ALERTA,
          mensagem: 'Texto com realce (marca de revisão do modelo)', local, valor: realcado.slice(0, 300), trecho: realcado.slice(0, 200) });
      }
      const vermelho = (p.runs || []).filter((r) => r.vermelho).map((r) => r.texto).join('').trim();
      if (vermelho) {
        add({ regra: 'vermelho', severidade: SEV.ALERTA, mensagem: 'Texto em vermelho', local, valor: vermelho.slice(0, 300), trecho: vermelho.slice(0, 200) });
      }
    }
  }

  for (const ag of Object.values(agregadas)) {
    add({ regra: ag.regra.id, severidade: ag.regra.severidade, mensagem: `${ag.regra.mensagem} — ${ag.total} ocorrência(s)`, local: { parte: 'documento' }, valor: String(ag.total), trecho: ag.exemplos.join(' · ') });
  }

  // parágrafos longos repetidos (copiar/colar duas vezes)
  const vistos = new Map();
  for (const p of paragrafosCorpo) {
    const k = normalizar(p.texto);
    if (k.length < 200) continue;
    if (vistos.has(k)) add({ regra: 'repetido', severidade: SEV.ALERTA, mensagem: 'Parágrafo repetido na peça', local: { parte: 'corpo', xmlIndice: p.i, arquivo: partes[0]?.arquivo, repeteIndice: vistos.get(k), ...(p.pagina ? { pagina: p.pagina } : {}) }, valor: '', trecho: p.texto.slice(0, 160) });
    else vistos.set(k, p.i);
  }

  for (const a of extras) add(a);

  // coerência com o processo
  if (dados) for (const a of conferirDados(textoCorpo, dados, cfg)) add(a);

  const resumo = { bloqueios: 0, alertas: 0, infos: 0, porRegra: contagem };
  for (const a of achados) {
    if (a.severidade === SEV.BLOQUEIO) resumo.bloqueios++;
    else if (a.severidade === SEV.ALERTA) resumo.alertas++;
    else resumo.infos++;
  }
  // a contagem por regra pode ser maior que os achados guardados (limite por regra)
  resumo.truncado = Object.values(contagem).some((v) => v > cfg.maxAchadosPorRegra);
  return { ok: resumo.bloqueios === 0, modo, versao: VERSAO, resumo, achados, paragrafos: paragrafosCorpo.length, ...meta };
}

const modoDe = (m) => (m === 'rascunho' ? 'rascunho' : 'protocolo');

async function conferirDocx(buffer, opts = {}) {
  const modo = modoDe(opts.modo);
  const cfg = { ...CONFIG_PADRAO, ...(opts.config || {}) };
  const { zip, documentXml } = await abrir(buffer, opts.JSZip);

  // partes do documento: corpo, notas, cabeçalhos/rodapés
  const partes = [{ parte: 'corpo', arquivo: 'word/document.xml', paras: paragrafosDoXml(documentXml) }];
  const fn = zip.file('word/footnotes.xml');
  if (fn) partes.push({ parte: 'nota de rodapé', arquivo: 'word/footnotes.xml', paras: paragrafosDoXml(await fn.async('string')) });
  const en = zip.file('word/endnotes.xml');
  if (en) partes.push({ parte: 'nota de fim', arquivo: 'word/endnotes.xml', paras: paragrafosDoXml(await en.async('string')) });
  for (const f of zip.file(/^word\/(header|footer)\d*\.xml$/)) {
    partes.push({ parte: f.name.includes('header') ? 'cabeçalho' : 'rodapé', arquivo: f.name, paras: paragrafosDoXml(await f.async('string')) });
  }

  // comentários e alterações controladas
  const extras = [];
  const comXml = zip.file('word/comments.xml') ? await zip.file('word/comments.xml').async('string') : '';
  const comentarios = (comXml.match(/<w:comment\b/g) || []).length;
  if (comentarios) {
    extras.push({ regra: 'comentarios', severidade: modo === 'protocolo' ? SEV.ALERTA : SEV.INFO, mensagem: `${comentarios} comentário(s) no arquivo — resolver e apagar antes de gerar o PDF`, local: { parte: 'documento' }, valor: String(comentarios), trecho: '' });
  }
  const revisoes = (documentXml.match(/<w:(?:ins|del)\b/g) || []).length;
  if (revisoes) {
    extras.push({ regra: 'revisoes', severidade: SEV.ALERTA, mensagem: `${revisoes} alteração(ões) controlada(s) pendente(s) — aceitar ou rejeitar`, local: { parte: 'documento' }, valor: String(revisoes), trecho: '' });
  }
  return conferirBlocos({ partes, modo, cfg, dados: opts.dados, extras, meta: { formato: 'docx' } });
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */
// Monta linhas a partir dos itens de texto do pdf.js (quebra quando muda a altura ou o item marca fim de linha)
function linhasDeItens(items) {
  let txt = ''; let ultimoY = null;
  for (const it of items || []) {
    if (typeof it.str !== 'string') continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : null;
    if (ultimoY != null && y != null && Math.abs(y - ultimoY) > 2 && !txt.endsWith('\n')) txt += '\n';
    txt += it.str;
    if (it.hasEOL) txt += '\n';
    if (y != null) ultimoY = y;
  }
  return txt;
}

async function importarPdfjs() {
  const caminhos = [process.env.PDFJS_PATH, 'pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/build/pdf.js', 'pdfjs-dist'].filter(Boolean);
  for (const c of caminhos) {
    try { const m = await import(c); const lib = m.getDocument ? m : m.default; if (lib?.getDocument) return lib; } catch { /* tenta o próximo */ }
  }
  return null;
}

// Devolve { paginas: [texto], anotacoes: n | null }. Ordem: extrator injetado → pdfjs-dist → pdf-parse (v1 ou v2).
async function extrairPdf(buffer, extrator) {
  if (typeof extrator === 'function') {
    const r = await extrator(buffer);
    return Array.isArray(r) ? { paginas: r, anotacoes: null } : r;
  }
  const pdfjs = await importarPdfjs();
  if (pdfjs) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    const paginas = []; let anotacoes = 0;
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        paginas.push(linhasDeItens((await pg.getTextContent()).items));
        const an = await pg.getAnnotations().catch(() => []);
        anotacoes += an.filter((x) => /^(Text|FreeText|Highlight|Underline|StrikeOut|Squiggly|Ink|Caret)$/.test(x.subtype)).length;
      }
    } finally { await doc.destroy?.(); }
    return { paginas, anotacoes };
  }
  let mod = null;
  try { mod = require('pdf-parse'); } catch { /* sem pdf-parse */ }
  if (typeof mod === 'function' || typeof mod?.default === 'function') {
    const fnParse = typeof mod === 'function' ? mod : mod.default;
    const paginas = [];
    await fnParse(buffer, { pagerender: async (pageData) => { const t = linhasDeItens((await pageData.getTextContent()).items); paginas.push(t); return t; } });
    return { paginas, anotacoes: null };
  }
  if (mod?.PDFParse) {
    const parser = new mod.PDFParse({ data: buffer });
    try {
      const r = await parser.getText();
      const paginas = Array.isArray(r?.pages) ? r.pages.map((x) => x.text || '') : String(r?.text || '').split('\f');
      return { paginas, anotacoes: null };
    } finally { await parser.destroy?.(); }
  }
  throw new Error('Para conferir PDF instale pdf-parse ou pdfjs-dist (npm i pdf-parse).');
}

// anotações por busca no arquivo (quando o extrator não informa); melhor esforço
function contarAnotacoesBrutas(buffer) {
  const s = buffer.toString('latin1');
  return (s.match(/\/Subtype\s*\/(?:Text|FreeText|Highlight|Underline|StrikeOut|Squiggly|Ink|Caret)\b/g) || []).length;
}

// Junta linhas em parágrafos: quebra em linha vazia, depois de ponto final/dois-pontos, quando muda de
// CAIXA ALTA para texto normal (títulos e instruções ficam sozinhos) e em itens de lista.
function paragrafosDePaginas(paginas) {
  const paras = []; let i = 0;
  const RE_ITEM = /^\s*(?:\d{1,3}[.)]|[a-z]\)|[•\-–—]\s)/;
  paginas.forEach((txt, idx) => {
    let atual = null;
    const fechar = () => { if (atual && atual.texto.trim()) paras.push(atual); atual = null; };
    for (const bruta of String(txt || '').split(/\n/)) {
      const linha = bruta.replace(/\s+/g, ' ').trim();
      if (!linha) { fechar(); continue; }
      const caixaAlta = proporcaoMaiusculas(linha) >= 0.8;
      if (atual) {
        const fimFrase = /[.:;!?)]$/.test(atual.texto);
        const iniciaInstrucao = caixaAlta && RE_INICIO_INSTRUCAO.test(limparInicio(linha));
        if (fimFrase || caixaAlta !== atual.caixaAlta || RE_ITEM.test(linha) || iniciaInstrucao) fechar();
      }
      if (!atual) { atual = { i: i++, texto: linha, runs: [], estilo: '', pagina: idx + 1, caixaAlta, pdf: true }; continue; }
      atual.texto = /[A-Za-zÀ-ÿ]-$/.test(atual.texto) && /^[a-zà-ÿ]/.test(linha) ? atual.texto.slice(0, -1) + linha : `${atual.texto} ${linha}`;
    }
    fechar();
  });
  return paras;
}

async function conferirPdf(buffer, opts = {}) {
  const modo = modoDe(opts.modo);
  const cfg = { ...CONFIG_PADRAO, ...(opts.config || {}) };
  const { paginas, anotacoes } = await extrairPdf(buffer, opts.extrairPdf);
  const paras = paragrafosDePaginas(paginas);
  const extras = [];
  const chars = paginas.join('').replace(/\s/g, '').length;
  const semTexto = paginas.length > 0 && chars < 80 * paginas.length && chars < 2000;
  if (semTexto) {
    extras.push({ regra: 'semTexto', severidade: SEV.ALERTA, mensagem: 'PDF sem texto pesquisável (digitalizado?): o conteúdo não pôde ser conferido', local: { parte: 'documento' }, valor: `${chars} caracteres em ${paginas.length} página(s)`, trecho: '' });
  }
  const nAnot = anotacoes ?? contarAnotacoesBrutas(buffer);
  if (nAnot) {
    extras.push({ regra: 'anotacoesPdf', severidade: SEV.ALERTA, mensagem: `${nAnot} anotação(ões)/comentário(s) no PDF`, local: { parte: 'documento' }, valor: String(nAnot), trecho: '' });
  }
  // sem texto, não faz sentido acusar número/parte ausentes
  return conferirBlocos({ partes: [{ parte: 'corpo', arquivo: 'pdf', paras }], modo, cfg, dados: semTexto ? null : opts.dados, extras, meta: { formato: 'pdf', paginas: paginas.length, semTexto } });
}

// Decide pelo conteúdo (não pela extensão): %PDF → PDF; PK → .docx
async function conferirArquivo(buffer, opts = {}) {
  const ini = buffer.subarray(0, 5).toString('latin1');
  if (ini.startsWith('%PDF')) return conferirPdf(buffer, opts);
  if (ini.startsWith('PK')) return conferirDocx(buffer, opts);
  const i = buffer.indexOf('%PDF');
  if (i > 0 && i < 1024) return conferirPdf(buffer.subarray(i), opts);
  throw new Error('Formato não suportado: a conferência lê .docx e .pdf.');
}

function conferirDados(texto, dados, cfg) {
  const out = [];
  const doc = { parte: 'documento' };
  const textoN = normalizar(texto);

  // número do processo: basta aparecer um dos números aceitos (principal, recurso/apenso, histórico)
  const aceitos = [...new Set([dados.numeroProcesso, ...(dados.numerosProcesso || [])].map(soDigitos).filter((d) => d.length === 20))];
  if (aceitos.length) {
    const cnjs = (texto.match(/\b\d{7}\s?-?\s?\d{2}\s?\.?\s?\d{4}\s?\.?\s?\d\s?\.?\s?\d{2}\s?\.?\s?\d{4}\b/g) || []).map(soDigitos);
    if (!cnjs.some((c) => aceitos.includes(c))) {
      const fmt = (d) => d.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, '$1-$2.$3.$4.$5.$6');
      out.push({ regra: 'processoAusente', severidade: SEV.BLOQUEIO, mensagem: `O número do processo (${fmt(aceitos[0])}) não aparece na peça`, local: doc, valor: aceitos.map(fmt).join(', '), trecho: cnjs.length ? `Números encontrados: ${[...new Set(cnjs)].slice(0, 3).map(fmt).join(', ')}` : 'Nenhum número CNJ encontrado' });
    }
  }

  // partes do cadastro (sem Análise Inicial): ao menos uma precisa aparecer
  const partes = (dados.partes || []).map((x) => String(x || '').trim()).filter((x) => normalizar(x).length >= 5);
  if (partes.length && !partes.some((x) => textoN.includes(normalizar(x)))) {
    out.push({ regra: 'partesAusentes', severidade: SEV.ALERTA, mensagem: 'Nenhuma das partes do cadastro aparece na peça (processo trocado?)', local: doc, valor: partes.join(' / '), trecho: '' });
  }

  // parte adversa
  if (dados.parteAdversa) {
    const nome = normalizar(dados.parteAdversa);
    if (nome.length >= 5 && !textoN.includes(nome)) {
      out.push({ regra: 'parteAusente', severidade: SEV.ALERTA, mensagem: `O nome da parte "${dados.parteAdversa}" não aparece na peça`, local: doc, valor: dados.parteAdversa, trecho: '' });
    }
  }

  // CNPJ do polo × outras empresas do grupo
  const cnpjsDoc = [...new Set((texto.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g) || []).map(soDigitos))];
  if (dados.cnpjPolo) {
    const polo = soDigitos(dados.cnpjPolo);
    const grupo = (dados.cnpjsGrupo || []).map(soDigitos).filter((c) => c && c !== polo);
    const outras = cnpjsDoc.filter((c) => grupo.includes(c));
    if (outras.length) {
      out.push({ regra: 'cnpjOutraEmpresa', severidade: SEV.ALERTA, mensagem: 'A peça cita CNPJ de outra empresa do grupo; confira a qualificação e a retificação do polo', local: doc, valor: outras.join(', '), trecho: `Polo definido na análise: ${dados.empresaPolo || ''} ${dados.cnpjPolo}`.trim() });
    }
    if (!cnpjsDoc.includes(polo)) {
      out.push({ regra: 'cnpjPoloAusente', severidade: SEV.ALERTA, mensagem: `O CNPJ da empresa do polo (${dados.cnpjPolo}) não aparece na peça`, local: doc, valor: dados.cnpjPolo, trecho: '' });
    }
  }

  // contratos citados × contratos conhecidos
  const conhecidos = (dados.contratos || []).map(soDigitos).filter((c) => c.length >= 4);
  if (conhecidos.length) {
    const citados = new Set();
    const re = /contrato(?:\(s\)|s)?\b[^.;\n]{0,80}?n[ºo°.]*\s*[:.]?\s*((?:\d[\d.\-/]{3,}\d)(?:\s*(?:,|e)\s*\d[\d.\-/]{3,}\d)*)/gi;
    let m;
    while ((m = re.exec(texto))) for (const n of m[1].split(/\s*(?:,|e)\s*/)) { const d = soDigitos(n); if (d.length >= 4) citados.add(d); }
    const estranhos = [...citados].filter((c) => !conhecidos.some((k) => k === c || k.endsWith(c) || c.endsWith(k)));
    if (estranhos.length) {
      out.push({ regra: 'contratoDesconhecido', severidade: SEV.ALERTA, mensagem: 'A peça cita contrato que não está na ficha nem nos subsídios', local: doc, valor: estranhos.join(', '), trecho: `Contratos do processo: ${conhecidos.join(', ')}` });
    }
    const textoD = soDigitos(texto);
    const faltam = conhecidos.filter((k) => !textoD.includes(k));
    if (faltam.length) {
      out.push({ regra: 'contratoNaoCitado', severidade: SEV.INFO, mensagem: 'Contrato do processo não citado na peça', local: doc, valor: faltam.join(', '), trecho: '' });
    }
  }

  // pedidos da inicial × impugnação
  const mapa = cfg.pedidos || {};
  for (const ped of dados.pedidos || []) {
    const codigo = typeof ped === 'string' ? ped : ped.codigo;
    const def = mapa[codigo];
    if (!def?.defesa) continue;
    if (!new RegExp(def.defesa, 'i').test(texto)) {
      out.push({ regra: 'pedidoSemImpugnacao', severidade: SEV.ALERTA, mensagem: `Pedido da inicial sem impugnação: ${def.nome || codigo} (art. 341 do CPC)`, local: doc, valor: codigo, trecho: typeof ped === 'object' && ped.trecho ? ped.trecho : '' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cópia anotada (comentários do Word)                                 */
/* ------------------------------------------------------------------ */
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TIPO_COMENTARIOS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const REL_COMENTARIOS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

function textoComentario(lista) {
  const linhas = [];
  for (const a of lista) {
    const sev = a.severidade === SEV.BLOQUEIO ? 'BLOQUEIO' : a.severidade === SEV.ALERTA ? 'Alerta' : 'Info';
    linhas.push(`${sev}: ${a.mensagem}${a.valor && a.valor.length <= 120 ? ` — "${a.valor}"` : ''}`);
  }
  return linhas;
}

function comentarioXml(id, linhas, autor, data) {
  const ps = linhas.map((l) => `<w:p><w:r><w:t xml:space="preserve">${escaparXml(l)}</w:t></w:r></w:p>`).join('');
  return `<w:comment w:id="${id}" w:author="${escaparXml(autor)}" w:date="${data}" w:initials="CG">${ps}</w:comment>`;
}

async function anotarDocx(buffer, achados, opts = {}) {
  const autor = opts.autor || 'Conferência Gomjur';
  const { zip, documentXml } = await abrir(buffer, opts.JSZip);
  const data = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const porParagrafo = new Map();
  const gerais = [];
  for (const a of achados || []) {
    if (a.local?.arquivo === 'word/document.xml' && Number.isInteger(a.local.xmlIndice)) {
      if (!porParagrafo.has(a.local.xmlIndice)) porParagrafo.set(a.local.xmlIndice, []);
      porParagrafo.get(a.local.xmlIndice).push(a);
    } else gerais.push(a);
  }

  let comXml = zip.file('word/comments.xml') ? await zip.file('word/comments.xml').async('string') : null;
  const idsExistentes = [...(comXml || '').matchAll(/w:id="(\d+)"/g), ...documentXml.matchAll(/<w:comment(?:RangeStart|RangeEnd|Reference)\b[^>]*w:id="(\d+)"/g)].map((m) => Number(m[1]));
  let proximo = (idsExistentes.length ? Math.max(...idsExistentes) : -1) + 1;
  const novos = [];

  const marcar = (inner, linhas) => {
    const id = proximo++;
    novos.push(comentarioXml(id, linhas, autor, data));
    const ppr = inner.match(/^\s*<w:pPr>[\s\S]*?<\/w:pPr>/);
    const cab = ppr ? ppr[0] : '';
    const resto = inner.slice(cab.length);
    return `${cab}<w:commentRangeStart w:id="${id}"/>${resto}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
  };

  let idx = -1;
  let primeiroComTexto = null;
  let novoDoc = documentXml.replace(RE_PARAGRAFO, (todo, inner) => {
    idx++;
    if (inner == null) return todo;
    if (primeiroComTexto == null && /<w:t[\s>]/.test(inner)) primeiroComTexto = idx;
    const lista = porParagrafo.get(idx);
    if (!lista) return todo;
    const abre = todo.slice(0, todo.length - inner.length - '</w:p>'.length);
    return `${abre}${marcar(inner, textoComentario(lista))}</w:p>`;
  });

  // achados gerais (do documento todo, notas, cabeçalhos) vão num comentário no primeiro parágrafo com texto
  if (gerais.length && primeiroComTexto != null) {
    idx = -1;
    const resumo = [`Resumo da conferência (${gerais.length} item(ns) fora do corpo ou do documento todo):`, ...textoComentario(gerais.map((a) => ({ ...a, mensagem: a.local?.parte && a.local.parte !== 'documento' ? `[${a.local.parte}] ${a.mensagem}` : a.mensagem })))];
    novoDoc = novoDoc.replace(RE_PARAGRAFO, (todo, inner) => {
      idx++;
      if (idx !== primeiroComTexto || inner == null) return todo;
      const abre = todo.slice(0, todo.length - inner.length - '</w:p>'.length);
      return `${abre}${marcar(inner, resumo)}</w:p>`;
    });
  }

  if (!novos.length) return buffer;
  zip.file('word/document.xml', novoDoc);

  if (comXml) {
    comXml = comXml.replace(/<\/w:comments>\s*$/, `${novos.join('')}</w:comments>`);
  } else {
    comXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${NS_W}">${novos.join('')}</w:comments>`;
    const relsPath = 'word/_rels/document.xml.rels';
    let rels = await zip.file(relsPath).async('string');
    if (!rels.includes(REL_COMENTARIOS)) {
      rels = rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="rIdGomjurComentarios" Type="${REL_COMENTARIOS}" Target="comments.xml"/></Relationships>`);
      zip.file(relsPath, rels);
    }
    let ct = await zip.file('[Content_Types].xml').async('string');
    if (!ct.includes('/word/comments.xml')) {
      ct = ct.replace(/<\/Types>\s*$/, `<Override PartName="/word/comments.xml" ContentType="${TIPO_COMENTARIOS}"/></Types>`);
      zip.file('[Content_Types].xml', ct);
    }
  }
  zip.file('word/comments.xml', comXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ------------------------------------------------------------------ */
/* Relatórios                                                          */
/* ------------------------------------------------------------------ */
const NOMES_REGRA = {
  variavel: 'Variável', lacuna: 'Lacuna XXXX', marcador: 'Marcador [ ]', instrucao: 'Instrução do modelo', notaInterna: 'Recado interno',
  pluralAberto: 'Singular/plural', linhaEmBranco: 'Linha em branco', destaque: 'Realce', vermelho: 'Vermelho', repetido: 'Parágrafo repetido',
  comentarios: 'Comentários', revisoes: 'Alterações controladas', processoAusente: 'Nº do processo', parteAusente: 'Nome da parte',
  cnpjOutraEmpresa: 'CNPJ de outra empresa', cnpjPoloAusente: 'CNPJ do polo', contratoDesconhecido: 'Contrato desconhecido',
  contratoNaoCitado: 'Contrato não citado', pedidoSemImpugnacao: 'Pedido sem impugnação',
  partesAusentes: 'Partes do cadastro', semTexto: 'PDF sem texto', anotacoesPdf: 'Anotações no PDF',
};

function descreverLocal(l = {}) {
  if (l.parte === 'documento' || !l.parte) return 'documento';
  return `${l.parte}${l.pagina ? `, p. ${l.pagina}` : ''}${l.paragrafo ? `, §${l.paragrafo}` : ''}${l.secao ? ` (${l.secao.slice(0, 50)})` : ''}`;
}

function relatorioTexto(r, nome = '') {
  const linhas = [];
  linhas.push(`${r.ok ? 'OK' : 'BLOQUEADA'} ${nome} — ${r.resumo.bloqueios} bloqueio(s), ${r.resumo.alertas} alerta(s), ${r.resumo.infos} info (modo ${r.modo})`);
  for (const a of r.achados) {
    if (a.severidade === SEV.INFO) continue;
    linhas.push(`  [${a.severidade === SEV.BLOQUEIO ? 'B' : 'A'}] ${descreverLocal(a.local)}: ${a.mensagem}${a.trecho ? ` — ${a.trecho.slice(0, 160)}` : ''}`);
  }
  return linhas.join('\n');
}

/* ------------------------------------------------------------------ */
/* Dados do processo para a coerência (processo + análise + pacote)    */
/* ------------------------------------------------------------------ */
function desembrulhar(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(desembrulhar);
  if ('valor' in x && ('pagina' in x || 'trecho' in x)) return desembrulhar(x.valor);
  const o = {};
  for (const [k, v] of Object.entries(x)) o[k] = desembrulhar(v);
  return o;
}

function dadosParaConferencia({ processo, analise, pacote } = {}) {
  const ficha = desembrulhar(analise?.ficha || {});
  const dec = analise?.parecer?.decisao || analise?.triagem?.aprovada || {};
  const polo = dec.poloPassivo || {};
  const contratos = new Set();
  for (const c of ficha.contratos || []) if (c?.numero) contratos.add(String(c.numero));
  if (dec.contrato?.numero) contratos.add(String(dec.contrato.numero));
  for (const c of dec.contratos || []) if (c?.numero) contratos.add(String(c.numero));
  return {
    numeroProcesso: processo?.numeroProcessoFull || processo?.numeroProcesso || null,
    parteAdversa: ficha.autor?.nome || processo?.ativo?.nome || processo?.extraFields?.nomeOutraParte || null,
    empresaPolo: polo.empresa || null,
    cnpjPolo: polo.cnpj || null,
    cnpjsGrupo: (pacote?.empresas || []).map((e) => e.cnpj).filter(Boolean),
    contratos: [...contratos],
    pedidos: (ficha.pedidos || []).map((p) => ({ codigo: p?.tipo, trecho: p?.descricao || p?.texto || '' })).filter((p) => p.codigo),
  };
}

module.exports = { dadosParaConferencia, conferirArquivo, conferirPdf, paragrafosDePaginas, conferirDocx, anotarDocx, relatorioTexto, descreverLocal, paragrafosDoXml, ehInstrucao, CONFIG_PADRAO, NOMES_REGRA, SEV, VERSAO };
