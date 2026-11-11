// node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluate, anosEntre } = require('../shared/regras');
const D = require('../shared/decisao');
const U = require('../shared/util');

const pacote = JSON.parse(fs.readFileSync(path.join(__dirname, '../pacotes/crefisa-2026.2.json'), 'utf8'));
const HOJE = '2026-10-21';

const fichaBase = (extra = {}) => ({
  autor: { nome: { valor: 'MARIA DA SILVA', pagina: 1, trecho: 'MARIA DA SILVA' }, cpf: { valor: '123.456.789-09', pagina: 1, trecho: 'CPF' }, menorOuIncapaz: false },
  poloPassivo: [{ nome: 'BANCO CREFISA S/A', cnpj: '61.033.106/0001-86' }],
  contratos: [{ numero: '0123456', produto: 'consignado' }],
  processo: { pedeGratuidade: true, caixaNoPolo: false },
  ...extra,
});

test('operadores de data', () => {
  assert.equal(anosEntre('2016-10-21', HOJE), 10);
  assert.equal(anosEntre('2016-10-22', HOJE), 9);
  assert.equal(evaluate({ dataAteInclusive: ['23/08/2023', '2023-08-23'] }, {}), true);
  assert.equal(evaluate({ dataAteInclusive: ['24/08/2023', '2023-08-23'] }, {}), false);
});

test('polo: consignado com Banco Crefisa no polo = sem retificação', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { produto: 'consignado', teses: [{ tese: 'revisional.consignado', confianca: 0.9 }] }, diligencias: {}, hoje: HOJE });
  assert.equal(dec.poloPassivo.empresaId, 'banco');
  assert.ok(!dec.preliminares.some((p) => p.preliminar === 'retificacao_polo_passivo'));
});

test('polo: empréstimo pessoal ajuizado contra o Banco Crefisa = retificação (1.7)', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase({ contratos: [{ produto: 'pessoal' }] }), triagemLLM: { produto: 'pessoal', teses: [{ tese: 'revisional.pessoal', confianca: 0.9 }] }, diligencias: {}, hoje: HOJE });
  assert.equal(dec.poloPassivo.empresaId, 'cfi');
  assert.ok(dec.preliminares.some((p) => p.preliminar === 'retificacao_polo_passivo'));
});

test('empresasNoPolo: "BANCO CREFISA S/A" não vira CFI por apelido', () => {
  assert.deepEqual(D.empresasNoPolo({ poloPassivo: [{ nome: 'BANCO CREFISA S/A' }] }, pacote), ['banco']);
  assert.deepEqual(D.empresasNoPolo({ poloPassivo: [{ nome: 'CREFISA S/A CREDITO FINANCIAMENTO E INVESTIMENTOS' }] }, pacote), ['cfi']);
});

test('conexão puxa abuso e gratuidade (1.2 a 1.4); captador por score', () => {
  const dec = D.decidirTriagem({
    pacote, ficha: fichaBase(),
    triagemLLM: { produto: 'consignado', teses: [{ tese: 'desconto.padrao', confianca: 0.95 }] },
    diligencias: { conexao: [{ numero: 'x' }], advogado: { faixa: 'ofensor' } }, hoje: HOJE,
  });
  const ids = dec.preliminares.map((p) => p.preliminar);
  for (const p of ['conexao', 'abuso_direito_demandar', 'revogacao_gratuidade', 'advogado_captador']) assert.ok(ids.includes(p), p);
});

test('fraude e revisional não ficam principais juntas (cap. 15)', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { produto: 'consignado', teses: [{ tese: 'revisional.consignado', confianca: 0.8 }, { tese: 'fraude', confianca: 0.9 }] }, diligencias: {}, hoje: HOJE });
  const principais = dec.teses.filter((t) => t.papel === 'principal').map((t) => t.tese);
  assert.deepEqual(principais, ['fraude']);
  assert.ok(dec.precisaRevisao.obrigatoria);
});

test('tese fora da taxonomia é descartada', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { teses: [{ tese: 'inventada', confianca: 1 }] }, diligencias: {}, hoje: HOJE });
  assert.equal(dec.teses.length, 0);
});

test('matriz: fraude.whats herda "*" e "fraude"', () => {
  const itens = D.subsidiosDaMatriz(pacote, ['fraude.whats']).map((x) => x.item);
  assert.ok(itens[0].startsWith('Telas do SAG'));
  assert.ok(itens.includes('Trilha da conversa no WhatsApp'));
  assert.ok(itens.includes('Trilha da contratação'));
});

test('exibição genérica: aguarda despacho e só pede SAG', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { teses: [{ tese: 'exibicao.generica', confianca: 0.9 }] }, diligencias: {}, hoje: HOJE });
  assert.ok(dec.aguardarDespacho);
  assert.equal(dec.subsidiosSolicitar.length, 1);
});

test('débito automático gera tentativa de acordo (cap. 8 e 13)', () => {
  const dec = D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { teses: [{ tese: 'cancelamento_debito', confianca: 0.9 }] }, diligencias: {}, hoje: HOJE });
  assert.equal(dec.acordo.length, 1);
});

const triagemAprovada = (teses) => D.decidirTriagem({ pacote, ficha: fichaBase(), triagemLLM: { produto: 'consignado', teses: teses.map((t) => ({ tese: t, confianca: 0.95 })) }, diligencias: {}, hoje: HOJE });

test('prescrição decenal bloqueia o contrato mesmo em fraude (1.9.3)', () => {
  const dec = D.decidirParecer({
    pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['fraude']),
    sag: { encontrado: true, contratos: [{ numero: '0123456', dataCelebracao: '2014-03-10', ultimoPagamento: '2016-01-10', status: 'liquidado', canal: 'filial' }] },
    hoje: HOJE,
  });
  assert.equal(dec.campos.prescricao, 'decenal');
  assert.ok(dec.bloqueados.some((b) => b.documento === 'contrato'));
  assert.ok(!dec.juntar.some((j) => j.documento === 'contrato'));
  assert.ok(dec.teses.some((t) => t.tese === 'fraude.filial'));
});

test('quinquenal em revisional sem sanção: não junta; com sanção: junta (1.9.2)', () => {
  const sag = { encontrado: true, contratos: [{ numero: '0123456', dataCelebracao: '2019-01-10', ultimoPagamento: '2020-05-10', status: 'liquidado' }] };
  const sem = D.decidirParecer({ pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['revisional.consignado']), sag, hoje: HOJE });
  assert.equal(sem.campos.prescricao, 'quinquenal');
  assert.ok(sem.bloqueados.some((b) => b.documento === 'contrato'));
  const com = D.decidirParecer({ pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['revisional.consignado']), sag, decisaoJudicial: { sancao: true }, hoje: HOJE });
  assert.ok(com.juntar.some((j) => j.documento === 'contrato'));
  assert.ok(!com.bloqueados.some((b) => b.documento === 'contrato'));
});

test('quinquenal em fraude: junta contrato e trilha independentemente de multa', () => {
  const dec = D.decidirParecer({
    pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['fraude']),
    sag: { encontrado: true, contratos: [{ numero: '0123456', dataCelebracao: '2019-01-10', ultimoPagamento: '2020-05-10', status: 'liquidado', canal: 'app' }] }, hoje: HOJE,
  });
  assert.ok(dec.juntar.some((j) => j.documento === 'contrato'));
  assert.ok(dec.juntar.some((j) => j.documento === 'trilha'));
  assert.ok(dec.teses.some((t) => t.tese === 'fraude.app'));
});

test('Toscana: até 23/08/2023 = gravação; depois = Web (6.7 e 6.8)', () => {
  const mk = (data) => D.decidirParecer({ pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['fraude']), sag: { encontrado: true, contratos: [{ numero: '0123456', dataCelebracao: data, ultimoPagamento: '2026-09-01', status: 'aberto', canal: 'toscana' }] }, hoje: HOJE });
  assert.ok(mk('2023-08-23').teses.some((t) => t.tese === 'fraude.toscana_ate_2308'));
  const depois = mk('2023-08-24');
  assert.ok(depois.teses.some((t) => t.tese === 'fraude.web'));
  assert.ok(!depois.teses.some((t) => t.tese === 'fraude.toscana_ate_2308'));
});

test('desconto em contrato aberto há mais de 5 anos do último pagamento: estorno + acordo (5.3)', () => {
  const dec = D.decidirParecer({ pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['desconto.padrao']), sag: { encontrado: true, contratos: [{ numero: '0123456', dataCelebracao: '2015-01-10', ultimoPagamento: '2020-01-10', status: 'aberto' }] }, hoje: HOJE });
  assert.ok(dec.teses.some((t) => t.tese === 'desconto.estorno'));
  assert.ok(dec.acordo.some((a) => /estorno/.test(a.motivo)));
});

test('SAG sem contrato: não é cliente (11)', () => {
  const dec = D.decidirParecer({ pacote, ficha: fichaBase(), decisaoTriagem: triagemAprovada(['fraude']), sag: { encontrado: false, contratos: [] }, hoje: HOJE });
  assert.ok(dec.teses.some((t) => t.tese === 'nao_cliente' && t.papel === 'principal'));
});

test('enquadrarRelacao: litispendência, coisa julgada, conexão', () => {
  const comp = { mesmasPartes: true, mesmoPedido: true, mesmaCausaDePedir: true, mesmaEmpresa: true };
  assert.equal(D.enquadrarRelacao({ transitado: false }, comp), 'litispendencia');
  assert.equal(D.enquadrarRelacao({ transitado: true }, comp), 'coisaJulgada');
  assert.equal(D.enquadrarRelacao({ transitado: false }, { ...comp, mesmoPedido: false }), 'conexao');
  assert.equal(D.enquadrarRelacao({ transitado: true }, { ...comp, mesmoPedido: false }), null);
});

test('util: CPF, CNJ, score, template, partes', () => {
  assert.equal(U.cpfValido('123.456.789-09'), true);
  assert.equal(U.cpfValido('123.456.789-00'), false);
  assert.equal(U.numeroCnjValido('0024772-81.2015.8.16.0001'), true);
  assert.equal(U.numeroCnjValido('0024772-82.2015.8.16.0001'), false);
  const s = U.calcularScore({ processos12m: 600, pctBancos: 0.8, contraCliente: 12, iniciaisSimilares: 0, comarcasForaUf: 0, documentosRepetidos: 1 });
  assert.equal(s.total, 25 + 25 + 8 + 10);
  assert.equal(s.faixa, 'atencao');
  assert.equal(U.calcularScore({ processos12m: 600, pctBancos: 0.8, contraCliente: 60, documentosRepetidos: 1 }).faixa, 'ofensor');
  assert.equal(U.renderTemplate('A {{x}}{{#itens}} -{{item}}{{/itens}}{{^vazio}} ok{{/vazio}}', { x: 1, itens: [{ item: 'a' }, { item: 'b' }], vazio: [] }), 'A 1 -a -b ok');
  assert.deepEqual(U.separarPartes('R C A CREDIT FOMENTO MERCANTIL LTDA X MARIO MARCIO MOURA GOMES'), { ativo: 'R C A CREDIT FOMENTO MERCANTIL LTDA', passivo: 'MARIO MARCIO MOURA GOMES' });
  assert.equal(U.ehInstituicaoFinanceira('CAIXA ECONOMICA FEDERAL - CEF'), true);
  assert.equal(U.ehInstituicaoFinanceira('MARIO MARCIO'), false);
});

test('regras do pacote não usam operadores inexistentes', () => {
  // avalia todas as condições com fatos vazios: só pode falhar por operador desconhecido
  const { executarRegras } = require('../shared/regras');
  for (const fase of ['triagem', 'parecer']) {
    const dec = executarRegras(pacote.regras, { hoje: HOJE }, fase);
    assert.deepEqual(dec.erros, [], JSON.stringify(dec.erros));
  }
});
