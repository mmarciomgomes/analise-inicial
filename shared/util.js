// shared/util.js — utilidades puras (CommonJS), usadas pelas rotas e pelo worker.
'use strict';

const crypto = require('node:crypto');
const { norm } = require('./regras');

/* ---------- CPF / CNPJ / processo ---------- */
const soDigitos = (s) => String(s ?? '').replace(/\D+/g, '');

function cpfValido(cpfRaw) {
  const c = soDigitos(cpfRaw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (base) => {
    let s = 0;
    for (let i = 0; i < base.length; i++) s += Number(base[i]) * (base.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(c.slice(0, 9)) === Number(c[9]) && dv(c.slice(0, 10)) === Number(c[10]);
}

function formatarCpf(c) {
  const d = soDigitos(c);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
}

// CPF dentro de um texto livre. O cadastro grava "CPF 044.671.515-83", "432.605.512-04 (NOME - 314218)",
// "CPF 154.338.203.78"...: pega o PRIMEIRO CPF do texto em vez de juntar todos os dígitos.
// Sem padrão de CPF, aceita só 11 dígitos puros; caso contrário devolve ''.
function cpfDoTexto(s) {
  const t = String(s ?? '');
  const m = t.match(/(?<!\d)\d{3}\.?\d{3}\.?\d{3}[-.]?\d{2}(?!\d)/);
  if (m) return soDigitos(m[0]);
  const d = soDigitos(t);
  return d.length === 11 && !/[A-Za-z]/.test(t) ? d : '';
}

// formatos possíveis de um CPF gravado em campos texto (para $in no Mongo).
// Na base real, ~99% dos valores vêm com o prefixo "CPF " (e alguns com ponto final).
function variantesCpf(c) {
  const d = cpfDoTexto(c) || soDigitos(c);
  if (!d) return [];
  const f = formatarCpf(d);
  return Array.from(new Set([d, f, `CPF ${d}`, `CPF ${f}`, `CPF ${f}.`, `${f}.`]));
}

// CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO
function numeroCnjValido(n) {
  const d = soDigitos(n);
  if (d.length !== 20) return false;
  const nnnnnnn = d.slice(0, 7), dd = d.slice(7, 9), resto = d.slice(9);
  // módulo 97 (Resolução CNJ 65/2008)
  const calc = 98 - Number(BigInt(`${nnnnnnn}${resto}00`) % 97n);
  return calc === Number(dd);
}

function formatarCnj(n) {
  const d = soDigitos(n);
  if (d.length !== 20) return String(n || '');
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}

function hashCurto(v) {
  return crypto.createHash('sha256').update(String(v ?? '')).digest('hex').slice(0, 16);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tokenAleatorio(n = 5) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += abc[b[i] % abc.length];
  return s;
}

/* ---------- Texto ---------- */
// similaridade simples por trigramas (0..1), suficiente para nomes e endereços
function trigramas(s) {
  const t = `  ${norm(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')}  `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
function similaridade(a, b) {
  if (!a || !b) return 0;
  const A = trigramas(a), B = trigramas(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

// normaliza texto de documento para hash (comprovante repetido)
function normalizarParaHash(txt) {
  return norm(txt).replace(/[^a-z0-9]+/g, '');
}

/* ---------- Assinatura de texto (MinHash) — "iniciais padronizadas" sem precisar de embeddings ---------- */
// shingles de 5 palavras; 64 permutações via FNV-1a com sementes. Similaridade ≈ Jaccard dos shingles.
function fnv1a(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function assinaturaTexto(texto, k = 64, limitePalavras = 4000) {
  const palavras = norm(texto).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, limitePalavras);
  const mins = new Array(k).fill(0xffffffff);
  for (let i = 0; i + 5 <= palavras.length; i++) {
    const sh = palavras.slice(i, i + 5).join(' ');
    for (let s = 0; s < k; s++) { const h = fnv1a(sh, s * 2654435761); if (h < mins[s]) mins[s] = h; }
  }
  return mins;
}
function similaridadeAssinaturas(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let iguais = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i] && a[i] !== 0xffffffff) iguais++;
  return iguais / a.length;
}

/* ---------- Modelos de texto ({{campo}}, {{#lista}}...{{/lista}}) ---------- */
function renderTemplate(tpl, dados) {
  const get = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  let out = String(tpl || '');
  // seções
  out = out.replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, inner) => {
    const v = get(dados, k);
    if (Array.isArray(v)) return v.map((item) => renderTemplate(inner, { ...dados, ...(typeof item === 'object' ? item : { item }), '.': item })).join('');
    return v ? renderTemplate(inner, dados) : '';
  });
  // invertidas
  out = out.replace(/\{\{\^([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, inner) => {
    const v = get(dados, k);
    return (!v || (Array.isArray(v) && !v.length)) ? renderTemplate(inner, dados) : '';
  });
  out = out.replace(/\{\{\s*\.\s*\}\}/g, () => String(dados['.'] ?? ''));
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = get(dados, k);
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}

/* ---------- Instituições financeiras ---------- */
const PADROES_IF = [
  /\bbanco\b/, /\bbco\b/, /financeira/, /financiamento/, /credito/, /\bcfi\b/, /\bs\.?\/?a\.?\s*cfi\b/,
  /caixa economica/, /\bcef\b/, /\bitau\b/, /bradesco/, /santander/, /\bpan\b/, /\bbmg\b/, /daycoval/,
  /crefisa/, /mercantil/, /\bc6\b/, /\binter\b/, /nubank/, /\bnu pagamentos\b/, /safra/, /\bbrb\b/,
  /sicredi/, /sicoob/, /cooperativa de credito/, /\bagibank\b/, /\bpicpay\b/, /fomento/, /securitizadora/,
  /cartao|cartoes/, /consignado/, /\bbv\b/, /votorantim/, /olé|ole consignado/, /paulista/, /facta/,
];
function ehInstituicaoFinanceira(nome, extras = []) {
  const n = norm(nome);
  if (!n) return false;
  if (PADROES_IF.some((re) => re.test(n))) return true;
  return extras.some((e) => n.includes(norm(e)));
}

/* ---------- Partes do jus.br: "AUTOR X REU" ---------- */
function separarPartes(partesTxt) {
  const s = String(partesTxt || '').replace(/\s+/g, ' ').trim();
  const m = s.split(/\s+X\s+/i);
  if (m.length >= 2) return { ativo: m[0].trim(), passivo: m.slice(1).join(' X ').trim() };
  return { ativo: s, passivo: '' };
}

/* ---------- Score de ofensor ---------- */
// pesos/faixas vêm de analiseConfig.score (ou do pacote). Valores default = proposta do doc (seção 4.5)
const SCORE_DEFAULT = {
  volume: { campo: 'processos12m', faixas: [[500, 25], [200, 15], [50, 8]] },
  concentracaoBancos: { campo: 'pctBancos', faixas: [[0.7, 25], [0.4, 12]] },
  contraCliente: { campo: 'contraCliente', faixas: [[50, 15], [10, 8]] },
  padronizacao: { campo: 'iniciaisSimilares', faixas: [[5, 15], [2, 8]] },
  pulverizacao: { campo: 'comarcasForaUf', faixas: [[10, 10], [5, 5]] },
  reusoDocumentos: { campo: 'documentosRepetidos', faixas: [[1, 10]] },
  cortes: { atencao: 40, ofensor: 70 },
};

function calcularScore(ind, cfg) {
  const c = { ...SCORE_DEFAULT, ...(cfg || {}) };
  const detalhe = {};
  let total = 0;
  for (const [nome, def] of Object.entries(c)) {
    if (nome === 'cortes' || !def || !Array.isArray(def.faixas)) continue;
    const v = Number(ind?.[def.campo] ?? 0);
    let pts = 0;
    for (const [limite, p] of def.faixas) { if (v >= limite) { pts = p; break; } }
    detalhe[nome] = { valor: v, pontos: pts };
    total += pts;
  }
  total = Math.min(100, total);
  const cortes = c.cortes || SCORE_DEFAULT.cortes;
  const faixa = total >= cortes.ofensor ? 'ofensor' : total >= cortes.atencao ? 'atencao' : 'normal';
  return { total, faixa, detalhe };
}

module.exports = {
  soDigitos, cpfDoTexto, cpfValido, formatarCpf, variantesCpf, numeroCnjValido, formatarCnj,
  hashCurto, sha256, tokenAleatorio, similaridade, normalizarParaHash, renderTemplate,
  ehInstituicaoFinanceira, separarPartes, calcularScore, SCORE_DEFAULT, norm,
  assinaturaTexto, similaridadeAssinaturas,
};
