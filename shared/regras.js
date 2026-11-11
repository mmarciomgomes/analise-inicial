// shared/regras.js
// Motor de regras declarativas da Análise Inicial (CommonJS: usado pelo jur.js e pelo worker).
//
// As regras de cada cliente ficam no PACOTE (coleção pacotesAnalise), em JSON, no formato
// JSON Logic (subconjunto) + operadores próprios de datas. O código só executa; não conhece
// nenhuma regra da Crefisa. Assim as regras continuam determinísticas, mas saem do código.
//
// Regra:
// {
//   "id": "polo-pessoal",
//   "fase": "triagem" | "parecer" | "ambas",
//   "descricao": "texto curto",
//   "fonte": "Manual 1.7",
//   "quando": <expressão>,
//   "entao": [ { "acao": "...", ...params } ]
// }
//
// Ações suportadas (o resultado é acumulado em um objeto "decisao"):
//   addTese            { tese, papel: "principal"|"subsidiaria", motivo }
//   addPreliminar      { preliminar, motivo }
//   poloPassivo        { empresa, cnpj }
//   addSubsidio        { item }
//   acordo             { motivo }
//   bloquearDocumento  { documento, motivo, providencia }
//   juntarDocumento    { documento, motivo }
//   alerta             { nivel: "info"|"atencao"|"vermelho", texto }
//   set                { campo, valor }      (grava em decisao.campos[campo])
//   aguardarDespacho   { motivo }

'use strict';

/* =========================
 * Datas
 * ========================= */
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(+v) ? null : v;
  const s = String(v).trim();
  // dd/mm/aaaa
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return Number.isNaN(+d) ? null : d;
  }
  // aaaa-mm-dd (com ou sem hora)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(+d) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(+d) ? null : d;
}

// anos completos entre duas datas (aniversário), d2 default = hoje
function anosEntre(d1, d2) {
  const a = toDate(d1);
  const b = toDate(d2) || new Date();
  if (!a) return null;
  let anos = b.getUTCFullYear() - a.getUTCFullYear();
  const mb = b.getUTCMonth(), ma = a.getUTCMonth();
  if (mb < ma || (mb === ma && b.getUTCDate() < a.getUTCDate())) anos -= 1;
  return anos;
}

function diasEntre(d1, d2) {
  const a = toDate(d1);
  const b = toDate(d2) || new Date();
  if (!a) return null;
  return Math.floor((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
    Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 864e5);
}

function cmpData(a, b) {
  const x = toDate(a), y = toDate(b);
  if (!x || !y) return null;
  return +x - +y;
}

/* =========================
 * Avaliador (JSON Logic, subconjunto + operadores próprios)
 * ========================= */
function getVar(data, path, dflt) {
  if (path === '' || path === null || path === undefined) return data;
  const parts = String(path).split('.');
  let cur = data;
  for (const p of parts) {
    if (cur === null || cur === undefined) return dflt === undefined ? null : dflt;
    cur = cur[p];
  }
  return cur === undefined ? (dflt === undefined ? null : dflt) : cur;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

function norm(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

const OPS = {
  '==': (a, b) => a == b,
  '===': (a, b) => a === b,
  '!=': (a, b) => a != b,
  '!==': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b, c) => (c === undefined ? a < b : a < b && b < c),
  '<=': (a, b, c) => (c === undefined ? a <= b : a <= b && b <= c),
  '!': (a) => !truthy(a),
  '!!': (a) => truthy(a),
  '+': (...a) => a.reduce((s, x) => s + Number(x || 0), 0),
  '-': (a, b) => (b === undefined ? -a : a - b),
  max: (...a) => Math.max(...a),
  min: (...a) => Math.min(...a),
  in: (a, b) => {
    if (Array.isArray(b)) return b.includes(a);
    return String(b ?? '').includes(String(a ?? ''));
  },
  cat: (...a) => a.map((x) => (x ?? '')).join(''),
  count: (a) => (Array.isArray(a) ? a.length : 0),

  // --- próprios ---
  // texto contém (sem acento / caixa)
  contem: (txt, trecho) => norm(txt).includes(norm(trecho)),
  // algum item da lista é igual (normalizado) a um dos valores
  temAlgum: (lista, valores) => {
    const L = (Array.isArray(lista) ? lista : [lista]).map(norm);
    const V = (Array.isArray(valores) ? valores : [valores]).map(norm);
    return L.some((x) => V.includes(x));
  },
  anosDesde: (d, ref) => anosEntre(d, ref),
  diasDesde: (d, ref) => diasEntre(d, ref),
  dataAntesDe: (a, b) => { const c = cmpData(a, b); return c === null ? null : c < 0; },
  dataAteInclusive: (a, b) => { const c = cmpData(a, b); return c === null ? null : c <= 0; },
  existe: (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
};

function evaluate(logic, data) {
  if (Array.isArray(logic)) return logic.map((l) => evaluate(l, data));
  if (logic === null || typeof logic !== 'object') return logic;

  const keys = Object.keys(logic);
  if (keys.length !== 1) return logic; // objeto literal
  const op = keys[0];
  let args = logic[op];
  if (!Array.isArray(args)) args = [args];

  // operadores com avaliação preguiçosa
  switch (op) {
    case 'var': {
      const [path, dflt] = args.map((a) => evaluate(a, data));
      return getVar(data, path, dflt);
    }
    case 'missing': {
      const paths = args.flat().map((a) => evaluate(a, data));
      return paths.filter((p) => !OPS.existe(getVar(data, p)));
    }
    case 'if':
    case '?:': {
      let i = 0;
      for (; i < args.length - 1; i += 2) {
        if (truthy(evaluate(args[i], data))) return evaluate(args[i + 1], data);
      }
      return i === args.length - 1 ? evaluate(args[i], data) : null;
    }
    case 'and': {
      let r = true;
      for (const a of args) { r = evaluate(a, data); if (!truthy(r)) return r; }
      return r;
    }
    case 'or': {
      let r = false;
      for (const a of args) { r = evaluate(a, data); if (truthy(r)) return r; }
      return r;
    }
    case 'some':
    case 'all':
    case 'none':
    case 'filter': {
      const arr = evaluate(args[0], data);
      const list = Array.isArray(arr) ? arr : [];
      const test = (item) => truthy(evaluate(args[1], item));
      if (op === 'some') return list.some(test);
      if (op === 'all') return list.length > 0 && list.every(test);
      if (op === 'none') return !list.some(test);
      return list.filter(test);
    }
    default: {
      const fn = OPS[op];
      if (!fn) throw new Error(`Operador desconhecido na regra: ${op}`);
      return fn(...args.map((a) => evaluate(a, data)));
    }
  }
}

/* =========================
 * Execução de regras do pacote
 * ========================= */
function novaDecisao() {
  return {
    teses: [],          // { tese, papel, motivo, regra }
    preliminares: [],   // { preliminar, motivo, regra }
    poloPassivo: null,  // { empresa, cnpj, regra }
    subsidios: [],      // { item, regra }
    acordo: [],         // { motivo, regra }
    bloqueados: [],     // { documento, motivo, providencia, regra }
    juntar: [],         // { documento, motivo, regra }
    alertas: [],        // { nivel, texto, regra }
    aguardarDespacho: null,
    campos: {},
    regrasAplicadas: [],
    erros: [],
  };
}

function pushUnique(arr, item, key) {
  if (!arr.some((x) => x[key] === item[key])) arr.push(item);
}

function aplicarAcao(dec, acao, regra) {
  const r = regra.id;
  switch (acao.acao) {
    case 'addTese': {
      const ex = dec.teses.find((t) => t.tese === acao.tese);
      if (ex) {
        if (acao.papel === 'principal') ex.papel = 'principal';
      } else {
        dec.teses.push({ tese: acao.tese, papel: acao.papel || 'principal', motivo: acao.motivo || regra.descricao, regra: r });
      }
      break;
    }
    case 'removerTese':
      dec.teses = dec.teses.filter((t) => t.tese !== acao.tese);
      break;
    case 'rebaixarTese': {
      const t = dec.teses.find((x) => x.tese === acao.tese);
      if (t) { t.papel = 'subsidiaria'; t.motivo = `${t.motivo} | ${acao.motivo || regra.descricao}`; }
      break;
    }
    case 'addPreliminar':
      pushUnique(dec.preliminares, { preliminar: acao.preliminar, motivo: acao.motivo || regra.descricao, regra: r }, 'preliminar');
      break;
    case 'poloPassivo':
      dec.poloPassivo = { empresaId: acao.empresaId || null, empresa: acao.empresa, cnpj: acao.cnpj, regra: r };
      break;
    case 'addSubsidio':
      pushUnique(dec.subsidios, { item: acao.item, regra: r }, 'item');
      break;
    case 'acordo':
      pushUnique(dec.acordo, { motivo: acao.motivo || regra.descricao, regra: r }, 'motivo');
      break;
    case 'bloquearDocumento':
      pushUnique(dec.bloqueados, { documento: acao.documento, motivo: acao.motivo || regra.descricao, providencia: acao.providencia || null, regra: r }, 'documento');
      dec.juntar = dec.juntar.filter((j) => j.documento !== acao.documento);
      break;
    case 'juntarDocumento':
      if (!dec.bloqueados.some((b) => b.documento === acao.documento)) {
        pushUnique(dec.juntar, { documento: acao.documento, motivo: acao.motivo || regra.descricao, regra: r }, 'documento');
      }
      break;
    case 'alerta':
      dec.alertas.push({ nivel: acao.nivel || 'atencao', texto: acao.texto, regra: r });
      break;
    case 'aguardarDespacho':
      dec.aguardarDespacho = { motivo: acao.motivo || regra.descricao, regra: r };
      break;
    case 'set':
      dec.campos[acao.campo] = acao.valor;
      break;
    default:
      dec.erros.push({ regra: r, erro: `Ação desconhecida: ${acao.acao}` });
  }
}

/**
 * Executa as regras do pacote sobre os fatos.
 * @param {Array} regras  pacote.regras
 * @param {Object} fatos  { ficha, triagemLLM, diligencias, sag, contrato, decisao(parcial), hoje }
 * @param {String} fase   'triagem' | 'parecer'
 * @param {Object} [decisaoBase] decisão anterior para continuar acumulando
 */
function executarRegras(regras, fatos, fase, decisaoBase) {
  const dec = decisaoBase ? JSON.parse(JSON.stringify(decisaoBase)) : novaDecisao();
  const lista = (Array.isArray(regras) ? regras : [])
    .filter((r) => r && r.ativo !== false && (r.fase === fase || r.fase === 'ambas'))
    .sort((a, b) => (a.ordem ?? 100) - (b.ordem ?? 100));

  for (const regra of lista) {
    let ok = false;
    try {
      // as regras enxergam também a decisão acumulada até aqui (ex.: "se já há tese fraude")
      ok = truthy(evaluate(regra.quando, { ...fatos, decisao: dec }));
    } catch (e) {
      dec.erros.push({ regra: regra.id, erro: e.message });
      continue;
    }
    if (!ok) continue;
    dec.regrasAplicadas.push(regra.id);
    for (const acao of regra.entao || []) aplicarAcao(dec, acao, regra);
  }
  return dec;
}

/* =========================
 * Prioridade (Manual cap. 15) + incompatibilidades
 * ========================= */
function consolidarTeses(dec, pacote) {
  const prioridade = pacote?.taxonomia?.prioridade || [];
  const incompat = pacote?.taxonomia?.incompativeis || []; // [["fraude","revisional"], ...]
  const ordem = (t) => {
    const i = prioridade.findIndex((p) => t.tese === p || String(t.tese).startsWith(`${p}.`));
    return i < 0 ? 999 : i;
  };
  const principais = dec.teses.filter((t) => t.papel === 'principal').sort((a, b) => ordem(a) - ordem(b));

  // teses incompatíveis não podem ser principais juntas: fica a de maior prioridade
  for (const [a, b] of incompat) {
    const ta = principais.find((t) => t.tese === a || String(t.tese).startsWith(`${a}.`));
    const tb = principais.find((t) => t.tese === b || String(t.tese).startsWith(`${b}.`));
    if (ta && tb) {
      const perdedora = ordem(ta) <= ordem(tb) ? tb : ta;
      perdedora.papel = 'subsidiaria';
      perdedora.motivo = `${perdedora.motivo} | incompatível com ${perdedora === ta ? tb.tese : ta.tese} como principal (Manual cap. 15)`;
      dec.alertas.push({ nivel: 'atencao', texto: `Conflito de teses: ${ta.tese} x ${tb.tese}. Mantida como principal a mais específica/prioritária.`, regra: 'consolidacao' });
    }
  }
  dec.teses.sort((a, b) => (a.papel === b.papel ? ordem(a) - ordem(b) : a.papel === 'principal' ? -1 : 1));
  return dec;
}

module.exports = {
  evaluate,
  executarRegras,
  consolidarTeses,
  novaDecisao,
  toDate,
  anosEntre,
  diasEntre,
  norm,
};
