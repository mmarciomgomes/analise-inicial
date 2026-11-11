// worker/lib/djen.mjs — consulta ao DJEN (comunicaapi) por OAB (perfil do advogado) e por NOME da parte (outras ações do autor).
// Mesmo endpoint já usado no prazo.mjs. Pública, sem token. Paginação com limite e intervalo.
//
// Peculiaridade da API: quando NÃO acha nada, ela devolve TUDO (count 10000); quando o advogado/parte tem muitos processos,
// também diz count 10000. Por isso nunca se confia no `count`: cada item é conferido (a OAB ou o nome inteiro tem de
// estar no item) e, se a 1ª página não traz nenhum item da busca, a consulta para (não existe resultado).
const URL = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const LIMITE_API = 10000;
const INTERVALO_MS = Number(process.env.PJE_DELAY_SECONDS || 2) * 1000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const ymd = (d) => d.toISOString().slice(0, 10);
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const soDig = (t) => String(t || '').replace(/\D+/g, '');
const mascaraCnj = (d) => (d.length === 20 ? `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}` : d);
const ehPassivo = (d) => String(d?.polo || '').toUpperCase().startsWith('P');

/** O item é da OAB buscada? (a API devolve tudo quando não acha) */
export function itemTemOab(it, numeroOab, ufOab) {
  const n = soDig(numeroOab); const uf = String(ufOab || '').toUpperCase();
  return (it?.destinatarioadvogados || []).some((d) => soDig(d?.advogado?.numero_oab) === n && String(d?.advogado?.uf_oab || '').toUpperCase() === uf);
}

/** O item tem a parte buscada (nome inteiro igual, sem acento/pontuação)? */
export function itemTemParte(it, nome) {
  const alvo = semAcento(nome);
  return (it?.destinatarios || []).some((d) => semAcento(d?.nome) === alvo);
}

/**
 * Pagina a API guardando só os itens que passam em `casa`. Para cedo quando a 1ª página (com count no teto) não traz nenhum.
 * @returns {{itens: object[], total: number, truncado: boolean, inconclusivo: boolean, semResultado: boolean}}
 */
async function paginar(params, { maxPaginas, casa }) {
  const itens = []; let total = 0; let truncado = false; let semResultado = false;
  for (let pagina = 1; ; pagina++) {
    if (pagina > maxPaginas) { truncado = true; break; }
    const q = new URLSearchParams({ ...params, itensPorPagina: '100', pagina: String(pagina) });
    const r = await fetch(`${URL}?${q}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 Gomjur-Analise', referer: 'https://comunicaapi.pje.jus.br/' } });
    if (r.status === 429) { await dormir(15000); pagina--; continue; }
    if (!r.ok) throw new Error(`DJEN HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    total = Number(data?.count || total);
    const certos = items.filter(casa);
    itens.push(...certos);
    if (pagina === 1 && certos.length === 0) { semResultado = true; break; } // sem nenhum item da busca: nada a ler
    if (items.length < 100) break;
    await dormir(INTERVALO_MS);
  }
  return { itens, total, truncado, inconclusivo: total >= LIMITE_API, semResultado };
}

/**
 * Processos em que a OAB recebeu comunicação (últimos `meses`).
 * @returns {Promise<{processos: Map<string, {numero, tribunal, orgao, partesPassivas:string[], partesAtivas:string[]}>, comunicacoes:number, paginas:number, truncado:boolean, inconclusivo:boolean, semResultado:boolean}>}
 */
export async function comunicacoesPorOab({ numeroOab, ufOab, meses = 12, maxPaginas = 15 }) {
  const fim = new Date();
  const ini = new Date(fim.getTime() - meses * 30 * 864e5);
  const r = await paginar({
    numeroOab: soDig(numeroOab), ufOab: String(ufOab || '').toUpperCase(),
    dataDisponibilizacaoInicio: ymd(ini), dataDisponibilizacaoFim: ymd(fim),
  }, { maxPaginas, casa: (it) => itemTemOab(it, numeroOab, ufOab) });

  const processos = new Map();
  for (const it of r.itens) {
    const numero = soDig(it.numero_processo || it.numeroprocessocommascara);
    if (!numero) continue;
    const atual = processos.get(numero) || { numero, tribunal: it.siglaTribunal || null, orgao: it.nomeOrgao || null, partesPassivas: [], partesAtivas: [] };
    for (const d of it.destinatarios || []) {
      const nome = String(d?.nome || '').trim();
      if (!nome) continue;
      const lista = ehPassivo(d) ? atual.partesPassivas : atual.partesAtivas;
      if (!lista.includes(nome)) lista.push(nome);
    }
    processos.set(numero, atual);
  }
  return { processos, comunicacoes: r.total, paginas: 0, truncado: r.truncado, inconclusivo: r.inconclusivo, semResultado: r.semResultado };
}

/* ---------- por NOME da parte (a API não tem busca por CPF) ---------- */
/**
 * Agrupa as comunicações por processo, guardando só as em que a parte buscada aparece como destinatária com o MESMO
 * nome (sem acento/pontuação). Função pura (testável). Por ser busca por nome, o resultado pode ter homônimos.
 * @returns {Array<{numero, tribunal, orgaoJulgador, classe, ativo, passivo, partes, poloDaParte, dataUltimoMovimento, link, comunicacoes}>}
 */
export function processosDoNome(items, nome, { ehBanco = () => false } = {}) {
  const alvo = semAcento(nome);
  const mapa = new Map();
  for (const it of items || []) {
    const dest = Array.isArray(it?.destinatarios) ? it.destinatarios : [];
    const eu = dest.find((d) => semAcento(d?.nome) === alvo);
    if (!eu) continue; // a API também devolve nomes parecidos; só vale o nome inteiro igual
    const numero = soDig(it.numero_processo || it.numeroprocessocommascara);
    if (!numero) continue;
    const ativos = []; const passivos = [];
    for (const d of dest) {
      const n = String(d?.nome || '').trim();
      if (n) (ehPassivo(d) ? passivos : ativos).push(n);
    }
    const data = String(it.data_disponibilizacao || '').slice(0, 10) || null;
    const atual = mapa.get(numero);
    if (!atual) {
      mapa.set(numero, {
        numero: mascaraCnj(numero), tribunal: it.siglaTribunal || null, orgaoJulgador: it.nomeOrgao || null, classe: it.nomeClasse || null,
        ativo: ativos.join(', '), passivo: passivos.join(', '), partes: `${ativos.join(', ')} X ${passivos.join(', ')}`,
        poloDaParte: ehPassivo(eu) ? 'passivo' : 'ativo', ehBanco: passivos.some((n) => ehBanco(n)),
        dataUltimoMovimento: data, link: it.link || null, comunicacoes: 1,
      });
    } else {
      atual.comunicacoes += 1;
      if (data && (!atual.dataUltimoMovimento || data > atual.dataUltimoMovimento)) atual.dataUltimoMovimento = data;
      atual.classe ||= it.nomeClasse || null;
    }
  }
  return Array.from(mapa.values());
}

/** Outras ações em que a parte (pelo NOME) recebeu comunicação. Sem CPF na API: possíveis homônimos. */
export async function comunicacoesPorNomeParte({ nome, maxPaginas = 5, ehBanco }) {
  const r = await paginar({ nomeParte: String(nome).trim() }, { maxPaginas, casa: (it) => itemTemParte(it, nome) });
  return { lista: processosDoNome(r.itens, nome, { ehBanco }), comunicacoes: r.total, truncado: r.truncado, inconclusivo: r.inconclusivo, semResultado: r.semResultado };
}
