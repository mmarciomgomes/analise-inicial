'use strict';
// Formatos reais de processos.extraFields.documentoOutraParte (87 mil registros do escritório Gomes).
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../shared/util');

test('cpfDoTexto: pega o primeiro CPF do texto e ignora o resto', () => {
  const casos = {
    'CPF 686.974.810-15': '68697481015',
    '432.605.512-04 (ALDALICE SOUZA CARDOZO - 314218)': '43260551204',
    'CPF 154.338.203.78': '15433820378',
    'CPF 014.084145-89': '01408414589',
    'CPF 71679090178': '71679090178',
    'CPF 064.753.882-20.': '06475388220',
    '68697481015': '68697481015',
    'Não Informado': '',
    'Tipo de documento não cadastrado ADENILDES DE ALMEIDA OLIVEIRA': '',
    '': '',
  };
  for (const [entrada, esperado] of Object.entries(casos)) assert.equal(U.cpfDoTexto(entrada), esperado, entrada);
});

test('variantesCpf cobre o prefixo "CPF " que a base usa (senão a base interna não acha ninguém)', () => {
  const v = U.variantesCpf('044.671.515-83');
  for (const gravado of ['CPF 044.671.515-83', 'CPF 04467151583', '044.671.515-83', '04467151583', 'CPF 044.671.515-83.']) {
    assert.ok(v.includes(gravado), `faltou ${gravado}`);
  }
});
