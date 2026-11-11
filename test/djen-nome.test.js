'use strict';
// Resposta real de https://comunicaapi.pje.jus.br/api/v1/comunicacao?nomeParte=... (recortada)
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../shared/util');

const dest = (nome, polo) => ({ comunicacao_id: 1, nome, polo });
const item = (over) => ({
  id: 1, data_disponibilizacao: '2026-11-06', siglaTribunal: 'TRT9', nomeOrgao: 'GAB. DES. X', nomeClasse: 'AGRAVO DE PETIçãO',
  numero_processo: '00021928020155090008', numeroprocessocommascara: '0002192-80.2015.5.09.0008', link: 'https://pje.trt9.jus.br/x',
  destinatarios: [dest('ADAO JOSE GOMES', 'P'), dest('MARCELO AUGUSTO ZAIDOWICZ PORTES', 'A'), dest('MARIO MARCIO MOURA GOMES', 'P')], ...over,
});

test('DJEN por nome: agrupa por processo, exige o nome inteiro e marca o polo da parte', async () => {
  const { processosDoNome } = await import('../worker/lib/djen.mjs');
  const itens = [
    item({}),
    item({ id: 2, data_disponibilizacao: '2026-12-01' }), // mesma ação, outra comunicação: soma e fica com a data mais nova
    item({ id: 3, numero_processo: '5006186562024824000', destinatarios: [dest('MARIO MARCIO GOMES', 'A'), dest('BANCO CREFISA S/A', 'P')] }), // nome parecido: ignora
    item({ id: 4, numero_processo: '08001234520268120001', numeroprocessocommascara: '0800123-45.2026.8.12.0001', siglaTribunal: 'TJMS', nomeClasse: 'PROCEDIMENTO COMUM',
      destinatarios: [dest('Mário Márcio Moura Gomes', 'A'), dest('BANCO CREFISA S/A', 'P')] }), // acento/caixa não importam
  ];
  const lista = processosDoNome(itens, 'MARIO MARCIO MOURA GOMES', { ehBanco: (n) => U.ehInstituicaoFinanceira(n) });
  assert.equal(lista.length, 2);
  const trabalhista = lista.find((p) => p.numero === '0002192-80.2015.5.09.0008');
  assert.equal(trabalhista.comunicacoes, 2);
  assert.equal(trabalhista.dataUltimoMovimento, '2026-12-01');
  assert.equal(trabalhista.poloDaParte, 'passivo');
  const civel = lista.find((p) => p.numero === '0800123-45.2026.8.12.0001');
  assert.equal(civel.poloDaParte, 'ativo');
  assert.equal(civel.ehBanco, true);
  assert.match(civel.passivo, /CREFISA/);
  assert.equal(civel.tribunal, 'TJMS');
});

test('DJEN: a API devolve "tudo" (count 10000) quando não acha; só vale item que tem a OAB ou o nome', async () => {
  const { itemTemOab, itemTemParte } = await import('../worker/lib/djen.mjs');
  const adv = (n, uf) => ({ advogado: { nome: 'X', numero_oab: n, uf_oab: uf } });
  const it = item({ destinatarioadvogados: [adv('8659', 'MS'), adv('52395', 'PR')] });
  assert.equal(itemTemOab(it, '8659', 'ms'), true);
  assert.equal(itemTemOab(it, '8659', 'PR'), false); // mesmo número, outra seccional
  assert.equal(itemTemOab(it, '12345', 'MS'), false);
  assert.equal(itemTemParte(it, 'Mário Márcio Moura Gomes'), true);
  assert.equal(itemTemParte(it, 'MARIO MARCIO'), false);
});
