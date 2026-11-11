// Etapa 4 — diligências: base interna (higienização), comprovante, fila do jus.br, perfil do advogado,
// e enquadramento de conexão / litispendência / coisa julgada.
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaComparacao } from '../lib/schemas.mjs';
import { comunicacoesPorOab, comunicacoesPorNomeParte } from '../lib/djen.mjs';
import { E, U, D, R, paginasDoSegmento } from '../lib/contexto.mjs';

const v = (x) => (x && typeof x === 'object' && 'valor' in x ? x.valor : x);

/* ---------- 4.3 / 4.4: base interna = coleção processos (higienização) ---------- */
export async function baseInterna(ctx, cpf) {
  const { db, processo, analise } = ctx;
  if (!cpf) return { processos: [], alertas: [{ nivel: 'atencao', texto: 'CPF da parte autora não localizado: base interna e jus.br não consultados.' }] };
  const variantes = U.variantesCpf(cpf);
  const porCadastro = await db.collection('processos').find({
    codigoEscritorio: processo.codigoEscritorio, _id: { $ne: processo._id }, 'extraFields.documentoOutraParte': { $in: variantes },
  }).project({ numeroProcesso: 1, numeroProcessoFull: 1, ativo: 1, passivo: 1, idCliente: 1, fase: 1, assunto: 1, nomeAcao: 1, dataCriacao: 1, comarca: 1, uf: 1 }).limit(200).toArray();
  const porAnalise = await db.collection('analiseInicial').find({ codigoEscritorio: processo.codigoEscritorio, cpfHash: U.hashCurto(cpf), idProcesso: { $ne: processo._id } })
    .project({ idProcesso: 1, 'ficha.autor': 1, 'ficha.pedidos': 1, 'ficha.fatos.resumo': 1, 'ficha.comprovanteResidencia': 1, oabsAdversas: 1 }).limit(200).toArray();

  const fichaPorProc = new Map(porAnalise.map((a) => [String(a.idProcesso), a]));
  const faltantes = porAnalise.filter((a) => !porCadastro.some((p) => String(p._id) === String(a.idProcesso))).map((a) => a.idProcesso);
  if (faltantes.length) {
    porCadastro.push(...await db.collection('processos').find({ _id: { $in: faltantes } }).project({ numeroProcesso: 1, numeroProcessoFull: 1, ativo: 1, passivo: 1, idCliente: 1, fase: 1, assunto: 1, nomeAcao: 1, dataCriacao: 1, comarca: 1, uf: 1 }).toArray());
  }

  const nomeAutor = v(analise?.ficha?.autor?.nome) || processo.ativo?.nome || '';
  const nasc = v(analise?.ficha?.autor?.dataNascimento);
  const alertas = [];
  const processos = porCadastro.map((p) => {
    const a = fichaPorProc.get(String(p._id));
    const nomeOutro = v(a?.ficha?.autor?.nome) || p.ativo?.nome || '';
    const sim = U.similaridade(nomeAutor, nomeOutro);
    if (nomeAutor && nomeOutro && sim < 0.5) alertas.push({ nivel: 'vermelho', texto: `Mesmo CPF com nome diferente no processo ${p.numeroProcessoFull || p.numeroProcesso}: "${nomeOutro}".` });
    const nascOutro = v(a?.ficha?.autor?.dataNascimento);
    if (nasc && nascOutro && R.toDate(nasc) && R.toDate(nascOutro) && +R.toDate(nasc) !== +R.toDate(nascOutro)) {
      alertas.push({ nivel: 'vermelho', texto: `Mesmo CPF com data de nascimento diferente no processo ${p.numeroProcessoFull || p.numeroProcesso}.` });
    }
    return {
      origem: 'interna', idProcesso: p._id, numero: p.numeroProcessoFull || p.numeroProcesso, idCliente: p.idCliente || null, ativo: p.ativo?.nome || null, passivo: p.passivo?.nome || null,
      classe: p.nomeAcao || null, assunto: p.assunto || null, fase: p.fase || null, transitado: /transit|arquiv|encerr|baixad/i.test(p.fase || '') ? null : false,
      pedidos: a?.ficha?.pedidos || null, resumo: v(a?.ficha?.fatos?.resumo) || null, oabs: a?.oabsAdversas || [],
    };
  });
  // troca de advogado em sequência no mesmo CPF
  const oabsAtuais = analise?.oabsAdversas || [];
  const outrasOabs = new Set(processos.flatMap((p) => p.oabs || []));
  if (oabsAtuais.length && outrasOabs.size && !oabsAtuais.some((o) => outrasOabs.has(o))) {
    alertas.push({ nivel: 'atencao', texto: `A parte já teve outras ações com advogado(s) diferente(s): ${Array.from(outrasOabs).join(', ')}.` });
  }
  return { processos, alertas };
}

/* ---------- 4.4: comprovante de residência ---------- */
export async function verificarComprovante(ctx) {
  const { db, processo, analise } = ctx;
  const ficha = analise?.ficha || {};
  const c = ficha.comprovanteResidencia || {};
  const seg = (analise?.ingestao?.segmentos || []).find((s) => s.tipo === 'comprovante_residencia');
  const alertas = [];
  if (!seg) return { encontrado: false, alertas: [{ nivel: 'atencao', texto: 'Comprovante de residência não identificado entre os documentos.' }] };

  const autor = v(ficha?.autor?.nome);
  const titular = v(c.titular);
  const temDeclaracaoTerceiro = (analise?.ingestao?.segmentos || []).some((s) => s.tipo === 'declaracao_residencia_terceiro');
  if (titular && autor && U.similaridade(titular, autor) < 0.5 && !temDeclaracaoTerceiro) {
    alertas.push({ nivel: 'atencao', texto: `Comprovante em nome de terceiro ("${titular}") sem declaração de residência.` });
  }
  const emissao = R.toDate(v(c.dataEmissao)) || R.toDate(v(c.mesReferencia));
  const ajuizamento = R.toDate(v(ficha?.processo?.dataAjuizamento)) || processo.dataCriacao || new Date();
  if (emissao) {
    const dias = R.diasEntre(emissao, ajuizamento);
    if (dias > 90) alertas.push({ nivel: 'atencao', texto: `Comprovante emitido ${dias} dias antes do ajuizamento.` });
  }
  const endInicial = v(ficha?.autor?.enderecoDeclarado);
  if (endInicial && v(c.endereco) && U.similaridade(endInicial, v(c.endereco)) < 0.45) {
    alertas.push({ nivel: 'atencao', texto: 'Endereço do comprovante diferente do declarado na inicial.' });
  }
  const cidadeComp = v(c.cidadeUf);
  const juizo = v(ficha?.processo?.juizo) || processo.comarca || '';
  if (cidadeComp && juizo && !R.norm(juizo).includes(R.norm(String(cidadeComp).split(/[-/]/)[0]).trim())) {
    alertas.push({ nivel: 'info', texto: `Comprovante em ${cidadeComp}; ação em ${juizo}: avaliar competência territorial.` });
  }

  // metadados do arquivo
  const meta = (analise?.ingestao?.documentos || []).find((d) => d.docId === seg.docId)?.meta;
  for (const s of meta?.sinais || []) alertas.push({ nivel: 'atencao', texto: `Comprovante: ${s}.` });

  // fingerprints (comprovante repetido em outras ações)
  const paginas = await paginasDoSegmento(db, seg);
  const textoComp = paginas.map((p) => p.texto).join('\n');
  const normal = U.normalizarParaHash(textoComp);
  const hashTexto = normal.length > 80 ? U.hashCurto(normal) : null;
  const docMeta = (analise?.ingestao?.documentos || []).find((d) => d.docId === seg.docId);
  const docInteiro = docMeta && seg.paginaInicial === 1 && seg.paginaFinal === docMeta.paginas;
  const hashArquivo = docInteiro ? docMeta.hash : null;
  const codCli = U.soDigitos(v(c.codigoClienteOuInstalacao));
  const chaveConta = codCli && v(c.mesReferencia) ? `${R.norm(v(c.emissor) || '')}|${codCli}|${v(c.mesReferencia)}` : null;

  const ors = [];
  if (hashTexto) ors.push({ hashTexto });
  if (hashArquivo) ors.push({ hashArquivo });
  if (chaveConta) ors.push({ chaveConta });
  let repetidos = [];
  if (ors.length) {
    repetidos = await db.collection('docFingerprints').find({ codigoEscritorio: processo.codigoEscritorio, idProcesso: { $ne: processo._id }, $or: ors }).limit(50).toArray();
    for (const r of repetidos) {
      const outroCpf = r.cpfHash && r.cpfHash !== analise.cpfHash;
      alertas.push({ nivel: 'vermelho', texto: `Comprovante de residência ${outroCpf ? 'de OUTRA parte' : 'já usado'} no processo ${r.numeroProcesso} (mesmo ${r.hashArquivo === hashArquivo && hashArquivo ? 'arquivo' : r.chaveConta === chaveConta && chaveConta ? 'código de cliente e mês' : 'texto'}).` });
    }
    await db.collection('docFingerprints').updateOne(
      { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, tipo: 'comprovante_residencia' },
      { $set: { hashTexto, hashArquivo, chaveConta, cpfHash: analise.cpfHash || null, oabs: analise.oabsAdversas || [], numeroProcesso: processo.numeroProcessoFull || processo.numeroProcesso, em: new Date() } },
      { upsert: true },
    );
  }
  return { encontrado: true, titular, emissao: emissao ? emissao.toISOString().slice(0, 10) : null, repetidoEm: repetidos.map((r) => r.numeroProcesso), alertas };
}

/* ---------- 4.2: outras ações da parte no DJEN (por nome; a API não tem busca por CPF) ---------- */
export async function outrasAcoesNoDjen(ctx, nome) {
  const { processo } = ctx;
  const r = await comunicacoesPorNomeParte({ nome, ehBanco: (n) => U.ehInstituicaoFinanceira(n) });
  const atual = U.soDigitos(processo.numeroProcessoFull || processo.numeroProcesso);
  const lista = r.lista.filter((p) => U.soDigitos(p.numero) !== atual).map((p) => ({ ...p, nomeBuscado: nome, confianca: 'nome' }));
  return { lista, comunicacoes: r.comunicacoes, truncado: r.truncado, inconclusivo: r.inconclusivo, semResultado: r.semResultado };
}

/* ---------- 4.5: perfil do advogado ---------- */
export async function atualizarPerfilAdvogado(ctx, { oab, uf, nome }) {
  const { db, processo, config, pacote } = ctx;
  const chave = { codigoEscritorio: processo.codigoEscritorio, oab: U.soDigitos(oab), uf: String(uf || '').toUpperCase() };
  const atual = await db.collection('perfilAdvogado').findOne(chave);

  // DJEN (reaproveita 30 dias)
  let djen = atual?.djen;
  if (!djen || !atual?.djenEm || Date.now() - +atual.djenEm > 30 * 864e5) {
    try {
      const r = await comunicacoesPorOab({ numeroOab: chave.oab, ufOab: chave.uf });
      const lista = Array.from(r.processos.values());
      const tribunais = Array.from(new Set(lista.map((p) => p.tribunal).filter(Boolean)));
      djen = {
        processos: lista.length, comunicacoes: r.comunicacoes, truncado: r.truncado, inconclusivo: r.inconclusivo,
        contraBancos: lista.filter((p) => p.partesPassivas.some((n) => U.ehInstituicaoFinanceira(n))).length,
        tribunais,
        // tribunais de outras UFs (sinal de advogado que atua longe de casa): TJxx/TRFx fora da UF da OAB
        tribunaisForaUf: tribunais.filter((t) => chave.uf && !String(t).toUpperCase().endsWith(chave.uf)).length,
      };
      await db.collection('perfilAdvogado').updateOne(chave, { $set: { djen, djenEm: new Date() } }, { upsert: true });
    } catch (e) {
      djen = atual?.djen || { erro: e.message };
    }
  }
  // base interna
  const oabKey = `${chave.oab}/${chave.uf}`;
  const contraCliente = await db.collection('analiseInicial').countDocuments({ codigoEscritorio: processo.codigoEscritorio, oabsAdversas: oabKey });
  const minhas = await db.collection('analiseInicial').find({ codigoEscritorio: processo.codigoEscritorio, oabsAdversas: oabKey, assinaturaInicial: { $exists: true } }).project({ assinaturaInicial: 1, idProcesso: 1 }).limit(300).toArray();
  let similares = 0;
  for (let i = 0; i < minhas.length; i++) {
    for (let j = i + 1; j < minhas.length; j++) {
      if (U.similaridadeAssinaturas(minhas[i].assinaturaInicial, minhas[j].assinaturaInicial) >= 0.9) { similares++; break; }
    }
  }
  const reuso = await db.collection('docFingerprints').aggregate([
    { $match: { codigoEscritorio: processo.codigoEscritorio, oabs: oabKey } },
    { $group: { _id: { $ifNull: ['$hashTexto', '$hashArquivo'] }, n: { $sum: 1 }, cpfs: { $addToSet: '$cpfHash' } } },
    { $match: { _id: { $ne: null }, n: { $gt: 1 } } },
  ]).toArray();
  const documentosRepetidos = reuso.filter((r) => r.cpfs.length > 1).length;

  const processos12m = djen?.processos || 0;
  const contraBancos = djen?.contraBancos || 0;
  const indicadores = {
    processos12m,
    pctBancos: processos12m ? contraBancos / processos12m : 0,
    contraCliente,
    iniciaisSimilares: similares,
    comarcasForaUf: djen?.tribunaisForaUf || 0,
    documentosRepetidos,
  };
  const score = U.calcularScore(indicadores, config.score || pacote.score || null);
  const manual = atual?.marcaManual ?? null; // { captador: true/false, por, motivo }
  const perfil = { ...chave, nome: nome || atual?.nome || null, indicadores, score, faixa: manual ? (manual.captador ? 'ofensor' : 'normal') : score.faixa, marcaManual: manual, atualizadoEm: new Date() };
  await db.collection('perfilAdvogado').updateOne(chave, { $set: perfil }, { upsert: true });
  return perfil;
}

/* ---------- 1.2 / 1.5 / 1.6: relação com outras ações ---------- */
export async function enquadrarRelacoes(ctx, outrasAcoes) {
  const { analise, pacote, processo } = ctx;
  const pre = D.preClassificarAcoes({ pacote, numeroAtual: processo.numeroProcessoFull || processo.numeroProcesso, outras: outrasAcoes });
  const candidatos = pre.contraGrupo.slice(0, 8);
  const res = { conexao: [], litispendencia: [], coisaJulgada: [], analisadas: [], contraOutrosBancos: pre.contraOutrosBancos.length };
  if (!candidatos.length) return res;

  const ficha = D.fichaPlana(analise.ficha || {});
  const atual = { pedidos: ficha.pedidos, resumo: ficha.fatos?.resumo, contratos: ficha.contratos, poloPassivo: ficha.poloPassivo };
  const { dados } = await chamarEstruturado({
    sistema: `${pacote.prompts?.comparacao || ''}\nTrechos do manual:\n${(pacote.manualTexto || '').split('1.7 RETIFICA')[0].slice(-9000)}`,
    usuario: `AÇÃO ATUAL (${processo.numeroProcessoFull || processo.numeroProcesso}):\n${JSON.stringify(atual)}\n\nOUTRAS AÇÕES DA MESMA PARTE CONTRA O GRUPO:\n${JSON.stringify(candidatos.map((c) => ({ numero: c.numero, partes: c.partes || `${c.ativo} X ${c.passivo}`, classe: c.classe, assunto: c.assunto, pedidos: c.pedidos, resumo: c.resumo, fase: c.fase, transitado: c.transitado, ultimoMovimento: c.dataUltimoMovimento || null, origem: c.origem })))}\n\nCompare cada uma com a atual. Use null quando não houver informação suficiente.`,
    nome: 'registrar_comparacoes', descricao: 'Compara a ação atual com as outras', schema: schemaComparacao, registrarUso: ctx.registrarUso,
  });
  for (const c of candidatos) {
    const comp = dados.comparacoes.find((x) => U.soDigitos(x.numero) === U.soDigitos(c.numero));
    const tipo = D.enquadrarRelacao(c, comp);
    res.analisadas.push({ numero: c.numero, origem: c.origem, comparacao: comp || null, enquadramento: tipo });
    if (tipo) res[tipo].push({ numero: c.numero, justificativa: comp?.justificativa || null, origem: c.origem, transitado: c.transitado });
  }
  return res;
}

export function juntarOutrasAcoes(interna, externas) {
  const mapa = new Map();
  for (const p of interna || []) mapa.set(U.soDigitos(p.numero), { ...p });
  for (const p of externas || []) {
    const k = U.soDigitos(p.numero);
    const ex = mapa.get(k);
    mapa.set(k, ex ? { ...p, ...ex, transitado: p.transitado ?? ex.transitado, dataUltimoMovimento: p.dataUltimoMovimento, origem: 'interna+djen' } : { ...p, origem: 'djen' });
  }
  return Array.from(mapa.values());
}

/* ---------- execução ---------- */
export async function executar(ctx) {
  const { db, processo, analise } = ctx;
  await ctx.estado(E.ESTADOS.DILIGENCIAS);
  const ficha = analise.ficha || {};
  const cpf = U.soDigitos(v(ficha?.autor?.cpf)) || U.cpfDoTexto(processo.extraFields?.documentoOutraParte) || null;
  const alertas = [...(analise.extracao?.alertas || [])];

  const interna = ctx.modulo('diligencias.baseInterna') ? await baseInterna(ctx, cpf) : { processos: [], alertas: [] };
  alertas.push(...interna.alertas);

  const comprovante = ctx.modulo('diligencias.comprovante') ? await verificarComprovante(ctx) : null;
  if (comprovante) alertas.push(...comprovante.alertas);

  // advogados: perfil (DJEN por OAB + base interna)
  const advogados = [];
  for (const a of (ficha.advogados || []).filter((x) => x.oab && x.uf).slice(0, 3)) {
    if (ctx.modulo('diligencias.perfilAdvogado')) advogados.push(await atualizarPerfilAdvogado(ctx, { oab: a.oab, uf: a.uf, nome: a.nome }));
  }

  // outras ações da parte no DJEN, pelo NOME (sem CPF na API: pode haver homônimo; a triagem só trata como indício)
  const nomeAutor = String(v(ficha?.autor?.nome) || processo.ativo?.nome || '').trim();
  let djenParte = { estado: ctx.modulo('diligencias.djen') ? (nomeAutor ? 'pendente' : 'sem_nome') : 'desligado' };
  let doDjen = [];
  if (djenParte.estado === 'pendente') {
    try {
      const r = await outrasAcoesNoDjen(ctx, nomeAutor);
      doDjen = r.lista;
      djenParte = { estado: r.semResultado ? 'sem_resultado' : 'concluido', nomeBuscado: nomeAutor, processos: doDjen.length, truncado: r.truncado, inconclusivo: r.inconclusivo, em: new Date() };
      if (doDjen.length) {
        alertas.push({
          nivel: 'atencao', regra: 'djen',
          texto: `DJEN: ${doDjen.length} processo(s) encontrados pelo NOME "${nomeAutor}" (a API não busca por CPF): pode haver homônimo. Confira o CPF antes de tratar como conexão, litispendência ou coisa julgada.`,
        });
      }
      if (doDjen.length && (r.truncado || r.inconclusivo)) alertas.push({ nivel: 'info', regra: 'djen', texto: 'DJEN: a parte tem muitas comunicações (a API limita a 10.000 e a busca foi cortada); a lista de processos pode estar incompleta.' });
    } catch (e) {
      djenParte = { estado: 'erro', erro: String(e.message).slice(0, 300), em: new Date() };
      alertas.push({ nivel: 'info', regra: 'djen', texto: `DJEN indisponível (${djenParte.erro}); outras ações pelo nome não foram consultadas.` });
    }
  }

  const outras = juntarOutrasAcoes(interna.processos, doDjen);
  const relacoes = await enquadrarRelacoes(ctx, outras);
  const pior = advogados.find((p) => p.faixa === 'ofensor') || advogados.find((p) => p.faixa === 'atencao') || advogados[0] || null;
  const diligencias = {
    cpfHash: cpf ? U.hashCurto(cpf) : null,
    outrasAcoes: outras,
    conexao: relacoes.conexao, litispendencia: relacoes.litispendencia, coisaJulgada: relacoes.coisaJulgada,
    comparacoes: relacoes.analisadas, contraOutrosBancos: relacoes.contraOutrosBancos,
    advogados, advogado: pior ? { oab: `${pior.oab}/${pior.uf}`, faixa: pior.faixa, score: pior.score?.total, captadorManual: processo.captador === true && processo.captadorOrigem !== 'analise' } : { captadorManual: processo.captador === true },
    comprovante, djen: djenParte,
    alertas, em: new Date(),
  };
  await ctx.salvar({ diligencias });
  await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'triagem', prioridade: 3 });
  return { outrasAcoes: outras.length, alertas: alertas.length };
}
