// shared/decisao.js — monta os fatos e toma as decisões determinísticas (triagem e parecer).
// Código puro: sem banco, sem LLM. Testado em test/decisao.test.js.
'use strict';

const { executarRegras, consolidarTeses, novaDecisao, norm, toDate } = require('./regras');
const { soDigitos } = require('./util');

const hojeISO = (d = new Date()) => {
  const x = toDate(d) || new Date();
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
};

// valor de um campo da ficha (cada campo vem como {valor, pagina, trecho} ou valor puro)
const v = (campo) => (campo && typeof campo === 'object' && 'valor' in campo ? campo.valor : campo);

// "achata" a ficha {valor,pagina,trecho} -> valores, para as regras lerem direto
function fichaPlana(ficha) {
  if (ficha === null || typeof ficha !== 'object') return ficha;
  if (Array.isArray(ficha)) return ficha.map(fichaPlana);
  if ('valor' in ficha && ('pagina' in ficha || 'trecho' in ficha)) return fichaPlana(ficha.valor);
  const out = {};
  for (const [k, val] of Object.entries(ficha)) out[k] = fichaPlana(val);
  return out;
}

// quais empresas do cliente estão no polo passivo indicado na inicial
function empresasNoPolo(fichaP, pacote) {
  const polo = Array.isArray(fichaP?.poloPassivo) ? fichaP.poloPassivo : [];
  const ids = new Set();
  for (const p of polo) {
    const cnpj = soDigitos(p?.cnpj);
    const porCnpj = cnpj && (pacote?.empresas || []).find((e) => soDigitos(e.cnpj) === cnpj);
    if (porCnpj) { ids.add(porCnpj.id); continue; }
    // por nome: se mais de uma empresa casar ("BANCO CREFISA S/A" casa "banco crefisa" e "crefisa s/a"),
    // vale o apelido que aparece primeiro no nome (e, empatando, o mais longo).
    const nome = norm(p?.nome);
    if (!nome) continue;
    let melhor = null;
    for (const e of pacote?.empresas || []) {
      for (const a of e.apelidos || []) {
        const idx = nome.indexOf(norm(a));
        if (idx < 0) continue;
        if (!melhor || idx < melhor.idx || (idx === melhor.idx && a.length > melhor.len)) melhor = { id: e.id, idx, len: a.length };
      }
    }
    if (melhor) ids.add(melhor.id);
  }
  return Array.from(ids);
}

function derivarProduto(fichaP, triagemLLM) {
  const doLLM = triagemLLM?.produto;
  if (doLLM && doLLM !== 'nao_identificado') return doLLM;
  const c = Array.isArray(fichaP?.contratos) ? fichaP.contratos.find((x) => x?.produto) : null;
  return c?.produto || null;
}

function idsTaxonomia(pacote) {
  return new Set((pacote?.taxonomia?.teses || []).map((t) => t.id));
}

function nomeTese(pacote, id) {
  return (pacote?.taxonomia?.teses || []).find((t) => t.id === id)?.nome || id;
}
function nomePreliminar(pacote, id) {
  return (pacote?.taxonomia?.preliminares || []).find((t) => t.id === id)?.nome || id;
}

// itens da matriz para as teses (por prefixo: "fraude.whats" herda "fraude" e "*")
function subsidiosDaMatriz(pacote, teses) {
  const m = pacote?.matrizSubsidios || {};
  const itens = [];
  const add = (lista, origem) => (lista || []).forEach((item) => {
    if (!itens.some((x) => x.item === item)) itens.push({ item, origem });
  });
  add(m['*'], '*');
  for (const t of teses || []) {
    const id = typeof t === 'string' ? t : t.tese;
    const partes = String(id).split('.');
    for (let i = 1; i <= partes.length; i++) {
      const chave = partes.slice(0, i).join('.');
      add(m[chave], chave);
    }
  }
  return itens;
}

function montarFatos({ pacote, ficha, triagemLLM, diligencias, sag, contrato, decisaoJudicial, hoje }) {
  const fichaP = fichaPlana(ficha || {});
  return {
    hoje: hojeISO(hoje),
    ficha: fichaP,
    triagemLLM: triagemLLM || {},
    diligencias: diligencias || {},
    produto: derivarProduto(fichaP, triagemLLM),
    poloEmpresas: empresasNoPolo(fichaP, pacote),
    sag: sag || {},
    contrato: contrato || {},
    decisaoJudicial: decisaoJudicial || {},
  };
}

/**
 * Triagem: parte das teses sugeridas pela LLM (filtradas pela taxonomia do pacote) e aplica as regras.
 */
function decidirTriagem({ pacote, ficha, triagemLLM, diligencias, hoje }) {
  const fatos = montarFatos({ pacote, ficha, triagemLLM, diligencias, hoje });
  const base = novaDecisao();
  const validas = idsTaxonomia(pacote);
  for (const t of triagemLLM?.teses || []) {
    if (!validas.has(t.tese)) {
      base.alertas.push({ nivel: 'atencao', texto: `A LLM sugeriu tese fora da taxonomia (${t.tese}); descartada.`, regra: 'taxonomia' });
      continue;
    }
    base.teses.push({ tese: t.tese, papel: t.papel === 'subsidiaria' ? 'subsidiaria' : 'principal', motivo: t.motivo || 'Sugerida pela leitura da inicial', confianca: t.confianca ?? null, regra: 'llm' });
  }
  let dec = executarRegras(pacote?.regras, fatos, 'triagem', base);
  dec = consolidarTeses(dec, pacote);

  // subsídios: matriz + itens que as regras pediram
  const daMatriz = subsidiosDaMatriz(pacote, dec.teses);
  for (const s of dec.subsidios) if (!daMatriz.some((x) => x.item === s.item)) daMatriz.push({ item: s.item, origem: `regra:${s.regra}` });
  dec.subsidiosSolicitar = dec.aguardarDespacho ? daMatriz.filter((x) => x.origem === '*') : daMatriz;

  // confiança da triagem = menor confiança entre as principais
  const confs = dec.teses.filter((t) => t.papel === 'principal' && typeof t.confianca === 'number').map((t) => t.confianca);
  dec.confianca = confs.length ? Math.min(...confs) : null;
  dec.precisaRevisao = precisaRevisao(dec, triagemLLM);
  dec.produto = fatos.produto;
  dec.poloEmpresasIndicadas = fatos.poloEmpresas;
  return dec;
}

/**
 * Regra de revisão humana (doc: Guardrails). O modo vem de analiseConfig.revisao.
 */
function precisaRevisao(dec, triagemLLM, cfgRevisao) {
  const cfg = { modo: 'assistido', confiancaMinima: 0.85, ...(cfgRevisao || {}) };
  const motivos = [];
  if (cfg.modo === 'sombra' || cfg.modo === 'assistido') motivos.push(`modo ${cfg.modo}: toda triagem é revisada`);
  if (dec.confianca === null || dec.confianca < cfg.confiancaMinima) motivos.push('confiança abaixo do mínimo');
  if (dec.alertas.some((a) => a.nivel === 'vermelho')) motivos.push('alerta vermelho');
  if (dec.alertas.some((a) => /Conflito de teses/.test(a.texto))) motivos.push('conflito de teses');
  if (dec.preliminares.some((p) => ['litispendencia', 'coisa_julgada', 'ilegitimidade_ativa'].includes(p.preliminar))) motivos.push('preliminar extintiva sugerida');
  if (!dec.teses.some((t) => t.papel === 'principal')) motivos.push('sem tese principal');
  if (triagemLLM?.precisaHumano) motivos.push('a leitura da inicial pediu revisão');
  return { obrigatoria: motivos.length > 0, motivos };
}

/**
 * Escolhe, entre os contratos do SAG, o discutido na ação (número citado; senão o mais recente em aberto).
 */
function escolherContrato(fichaP, sag) {
  const contratos = Array.isArray(sag?.contratos) ? sag.contratos : [];
  if (!contratos.length) return null;
  const citados = (fichaP?.contratos || []).map((c) => soDigitos(c?.numero)).filter(Boolean);
  const porNumero = contratos.find((c) => citados.includes(soDigitos(c?.numero)));
  if (porNumero) return { ...porNumero, criterio: 'numero citado na inicial' };
  const abertos = contratos.filter((c) => c?.status === 'aberto');
  const ordenar = (arr) => arr.slice().sort((a, b) => (+(toDate(b.dataCelebracao) || 0)) - (+(toDate(a.dataCelebracao) || 0)));
  if (abertos.length) return { ...ordenar(abertos)[0], criterio: 'contrato em aberto mais recente (inicial não cita número)' };
  return { ...ordenar(contratos)[0], criterio: 'contrato mais recente (inicial não cita número)' };
}

/**
 * Parecer: reaplica regras com SAG, contrato e decisão judicial, partindo da decisão da triagem aprovada.
 */
function decidirParecer({ pacote, ficha, triagemLLM, diligencias, decisaoTriagem, sag, contrato, decisaoJudicial, hoje }) {
  const fichaP = fichaPlana(ficha || {});
  const contratoEsc = contrato || escolherContrato(fichaP, sag);
  const fatos = montarFatos({ pacote, ficha, triagemLLM, diligencias, sag, contrato: contratoEsc || {}, decisaoJudicial, hoje });
  const base = JSON.parse(JSON.stringify(decisaoTriagem || novaDecisao()));
  base.regrasAplicadas = base.regrasAplicadas || [];
  base.erros = [];
  let dec = executarRegras(pacote?.regras, fatos, 'parecer', base);
  dec = consolidarTeses(dec, pacote);
  dec.contrato = contratoEsc;

  // conferências cruzadas
  const citados = (fichaP?.contratos || []).map((c) => soDigitos(c?.numero)).filter(Boolean);
  if (citados.length && sag?.encontrado && !((sag.contratos || []).some((c) => citados.includes(soDigitos(c?.numero))))) {
    dec.alertas.push({ nivel: 'atencao', texto: `Contrato(s) citado(s) na inicial (${citados.join(', ')}) não aparece(m) no SAG.`, regra: 'conferencia' });
  }

  // subsídios ainda necessários que não vieram
  const necessarios = subsidiosDaMatriz(pacote, dec.teses).map((x) => x.item)
    .concat(dec.subsidios.map((s) => s.item));
  dec.subsidiosNecessarios = Array.from(new Set(necessarios));
  return dec;
}

/**
 * Pré-classificação determinística das ações encontradas (antes da comparação por LLM).
 * outras: [{ numero, partes, ativo, passivo, classe, assunto, transitado, situacao, origem }]
 */
function preClassificarAcoes({ pacote, numeroAtual, outras }) {
  const grupo = (pacote?.nomesGrupoCliente || []).map(norm);
  const atual = soDigitos(numeroAtual);
  const res = { contraGrupo: [], contraOutrosBancos: [], outras: [] };
  for (const o of outras || []) {
    if (soDigitos(o.numero) === atual) continue;
    const passivo = norm(o.passivo || o.partes);
    if (grupo.some((g) => passivo.includes(g))) res.contraGrupo.push(o);
    else if (o.ehBanco) res.contraOutrosBancos.push(o);
    else res.outras.push(o);
  }
  return res;
}

/**
 * Converte a comparação (LLM) em conexão / litispendência / coisa julgada (Manual 1.2, 1.5, 1.6 e cap. 15).
 * comp: { mesmoPedido, mesmaCausaDePedir, mesmasPartes, mesmaEmpresa, faseConhecimento }
 */
function enquadrarRelacao(acao, comp) {
  if (!comp) return null;
  const transitado = acao.transitado === true;
  if (comp.mesmasPartes && comp.mesmoPedido && comp.mesmaCausaDePedir) {
    return transitado ? 'coisaJulgada' : 'litispendencia';
  }
  if (comp.mesmaCausaDePedir && comp.mesmaEmpresa && !transitado && comp.faseConhecimento !== false) return 'conexao';
  return null;
}

module.exports = {
  fichaPlana, empresasNoPolo, derivarProduto, subsidiosDaMatriz, montarFatos,
  decidirTriagem, decidirParecer, precisaRevisao, escolherContrato,
  preClassificarAcoes, enquadrarRelacao, nomeTese, nomePreliminar, hojeISO, v,
};
