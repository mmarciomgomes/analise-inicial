// Testes da conferência de peças. Rodar: node --test test/conferencia.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/conferencia');

function carregarJSZip() {
  const tentar = (id) => { try { const m = require(id); return typeof m?.loadAsync === 'function' ? m : null; } catch { return null; } };
  return tentar('jszip') || (process.env.JSZIP_PATH && tentar(process.env.JSZIP_PATH));
}
const JSZip = carregarJSZip();
const pular = !JSZip && 'jszip não instalado (npm i, ou JSZIP_PATH=/caminho/jszip)';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// p('texto') | p([{t:'a'},{t:'b', hl:'yellow'}], {estilo:'Heading1'})
function p(runs, o = {}) {
  const rs = (Array.isArray(runs) ? runs : [{ t: runs }]).map((r) => {
    const rpr = [r.b ? '<w:b/>' : '', r.cor ? `<w:color w:val="${r.cor}"/>` : '', r.hl ? `<w:highlight w:val="${r.hl}"/>` : ''].join('');
    const corpo = r.del ? `<w:delText>${esc(r.t)}</w:delText>` : `<w:t xml:space="preserve">${esc(r.t)}</w:t>`;
    const run = `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}${corpo}</w:r>`;
    return r.del ? `<w:del w:id="9" w:author="x">${run}</w:del>` : run;
  }).join('');
  return `<w:p>${o.estilo ? `<w:pPr><w:pStyle w:val="${o.estilo}"/></w:pPr>` : ''}${rs}</w:p>`;
}
async function docx(paras, extras = {}) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`);
  for (const [k, v] of Object.entries(extras)) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer' });
}
const regras = (r) => r.achados.map((a) => a.regra);

const LIMPA = [
  p([{ t: 'EXCELENTÍSSIMO SENHOR DOUTOR JUIZ DE DIREITO DA 2ª VARA CÍVEL DA COMARCA DE SÃO PAULO/SP', b: true }]),
  p('Processo nº 1001234-56.2026.8.26.0100'),
  p('BANCO CREFISA S/A, inscrito no CNPJ sob o nº 61.033.106/0001-86, nos autos da ação movida por MARIA DA SILVA SOUZA, vem apresentar CONTESTAÇÃO.'),
  p([{ t: 'DOS DANOS MORAIS', b: true }]),
  p('Não há dano moral a indenizar, conforme o contrato nº 123456789 celebrado em 10/01/2024 (art. 5º, inciso XXXVI, da Constituição; REsp 1.061.530/RS).'),
  p('Ante o exposto, requer a improcedência dos pedidos [...] e a condenação da parte autora (CPC, art. 85).'),
];
const DADOS = { numeroProcesso: '1001234-56.2026.8.26.0100', parteAdversa: 'Maria da Silva Souza', empresaPolo: 'BANCO CREFISA S/A', cnpjPolo: '61033106000186', cnpjsGrupo: ['60779196000196', '61033106000186'], contratos: ['123456789'], pedidos: [{ codigo: 'dano_moral' }] };
const CFG = { pedidos: { dano_moral: { nome: 'Danos morais', defesa: 'danos? mora(?:l|is)' }, tutela_urgencia: { nome: 'Tutela', defesa: 'tutela' } } };

test('peça limpa passa sem bloqueios nem alertas (sem falso positivo em inciso XXXVI, [...] e parênteses comuns)', { skip: pular }, async () => {
  const r = await C.conferirDocx(await docx(LIMPA), { JSZip, dados: DADOS, config: CFG });
  assert.equal(r.ok, true, C.relatorioTexto(r));
  assert.deepEqual(r.achados.filter((a) => a.severidade !== 'info'), []);
});

test('acha variável, XXXX, marcador, instrução entre parênteses e em linha própria, recado interno', { skip: pular }, async () => {
  const b = await docx([
    p('EXCELENTÍSSIMO SENHOR DOUTOR JUIZ DE DIREITO DA VAR_VARA DA VAR_COMARCAESTADO.'),
    p('Celebrou o contrato nº XXXXXXXXXXXX, firmado com a Ré.'),
    p('Advogado: [ADVOGADO] — OAB [OAB]'),
    p('DA RETIFICAÇÃO DO POLO PASSIVO (CONFIRMAR SE É CASO DE PEDIR RETIFICAÇÃO)'),
    p('- APENAS QUANDO A PARTE TIVER NEGATIVADA POR OUTRAS INSTITUIÇÕES FINANCEIRA TAMBÉM'),
    p('(SEMPRE SERÁ CONFORME O CASO – PRÓXIMO QUE PEGAR UM CASO DESSE MODELO FALAR COMIGO)'),
    p('Valor da parcela: R$ xx, vencimento em 05/XX/20XX.'),
  ]);
  const r = await C.conferirDocx(b, { JSZip });
  const rs = regras(r);
  assert.equal(r.ok, false);
  assert.equal(rs.filter((x) => x === 'variavel').length, 2);
  assert.ok(rs.filter((x) => x === 'lacuna').length >= 3);
  assert.equal(rs.filter((x) => x === 'marcador').length, 2);
  assert.equal(rs.filter((x) => x === 'instrucao').length, 3);
  assert.ok(rs.includes('notaInterna'));
  const inst = r.achados.find((a) => a.regra === 'instrucao');
  assert.equal(inst.local.parte, 'corpo');
  assert.equal(inst.local.paragrafo, 4);
});

test('realce bloqueia no modo protocolo e só alerta no rascunho; texto apagado (controle de alterações) não conta', { skip: pular }, async () => {
  const b = await docx([...LIMPA, p([{ t: 'Trecho opcional ', hl: 'yellow' }, { t: 'normal' }]), p([{ t: 'VAR_APAGADA', del: true }]), p([{ t: 'em vermelho', cor: 'FF0000' }])]);
  const prot = await C.conferirDocx(b, { JSZip });
  assert.equal(prot.achados.find((a) => a.regra === 'destaque').severidade, 'bloqueio');
  assert.equal(prot.achados.find((a) => a.regra === 'destaque').valor, 'Trecho opcional');
  assert.ok(!regras(prot).includes('variavel'));
  assert.ok(regras(prot).includes('revisoes'));
  assert.ok(regras(prot).includes('vermelho'));
  const ras = await C.conferirDocx(b, { JSZip, modo: 'rascunho' });
  assert.equal(ras.achados.find((a) => a.regra === 'destaque').severidade, 'alerta');
  assert.equal(ras.ok, true);
});

test('olha notas de rodapé e cabeçalho', { skip: pular }, async () => {
  const b = await docx(LIMPA, {
    'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes xmlns:w="${W}"><w:footnote w:id="1">${p('(VERIFICAR NECESSIDADE) ver contrato XXXX')}</w:footnote></w:footnotes>`,
    'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W}">${p('Processo VAR_NUMEROPROCESSO')}</w:hdr>`,
  });
  const r = await C.conferirDocx(b, { JSZip });
  const partes = r.achados.map((a) => `${a.regra}@${a.local.parte}`);
  assert.ok(partes.includes('instrucao@nota de rodapé'));
  assert.ok(partes.includes('lacuna@nota de rodapé'));
  assert.ok(partes.includes('variavel@cabeçalho'));
});

test('coerência com o processo: número, parte, CNPJ de outra empresa, contrato desconhecido, pedido sem impugnação', { skip: pular }, async () => {
  const b = await docx([
    p('Processo nº 0009999-11.2025.8.26.0001'),
    p('CREFISA S/A CRÉDITO, FINANCIAMENTO E INVESTIMENTOS, CNPJ 60.779.196/0001-96, nos autos da ação movida por JOSÉ PEREIRA.'),
    p('O contrato nº 555444333 foi regularmente celebrado.'),
  ]);
  const r = await C.conferirDocx(b, { JSZip, dados: { ...DADOS, pedidos: [{ codigo: 'dano_moral' }, { codigo: 'tutela_urgencia' }] }, config: CFG });
  const rs = regras(r);
  for (const x of ['processoAusente', 'parteAusente', 'cnpjOutraEmpresa', 'cnpjPoloAusente', 'contratoDesconhecido', 'contratoNaoCitado', 'pedidoSemImpugnacao']) assert.ok(rs.includes(x), x);
  assert.equal(rs.filter((x) => x === 'pedidoSemImpugnacao').length, 2);
  assert.equal(r.achados.find((a) => a.regra === 'processoAusente').severidade, 'bloqueio');
});

test('regras extras do pacote e regras desligadas', { skip: pular }, async () => {
  const b = await docx([...LIMPA, p('Conforme modelo da filial MG, o(s) contrato(s) …')]);
  const r = await C.conferirDocx(b, { JSZip, config: { regrasExtras: [{ id: 'filialMG', padrao: 'filial MG', severidade: 'bloqueio', mensagem: 'Texto exclusivo de MG' }], desligar: ['pluralAberto'] } });
  assert.ok(regras(r).includes('filialMG'));
  assert.ok(!regras(r).includes('pluralAberto'));
  assert.equal(r.ok, false);
});

test('cópia anotada: um comentário por parágrafo com achado + resumo; ids não colidem com comentários existentes', { skip: pular }, async () => {
  const existente = `<?xml version="1.0"?><w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Dra. Ana"><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:comment></w:comments>`;
  const b = await docx([...LIMPA, p('contrato XXXXXXXX (CONFIRMAR SE PEDIU)'), p([{ t: 'opcional', hl: 'yellow' }])], { 'word/comments.xml': existente });
  const r = await C.conferirDocx(b, { JSZip, dados: { ...DADOS, contratos: ['123456789', '999'] } });
  const anot = await C.anotarDocx(b, r.achados, { JSZip });
  const z = await JSZip.loadAsync(anot);
  const doc = await z.file('word/document.xml').async('string');
  const com = await z.file('word/comments.xml').async('string');
  assert.equal((com.match(/<w:comment\b/g) || []).length, 1 + 3); // existente + 2 parágrafos + resumo (comentário existente/contrato não citado)
  assert.ok(!/w:id="7"[^>]*w:author="Conferência/.test(com));
  assert.match(com, /BLOQUEIO: Lacuna/);
  assert.equal((doc.match(/<w:commentRangeStart/g) || []).length, 3);
  assert.equal((doc.match(/<w:commentReference/g) || []).length, 3);
  // relê: o anotado continua conferível
  const r2 = await C.conferirDocx(anot, { JSZip });
  assert.ok(r2.achados.some((a) => a.regra === 'comentarios'));
});

test('cópia anotada cria comments.xml, relação e content type quando não existem', { skip: pular }, async () => {
  const b = await docx([p('VAR_VARA')]);
  const r = await C.conferirDocx(b, { JSZip });
  const z = await JSZip.loadAsync(await C.anotarDocx(b, r.achados, { JSZip }));
  assert.ok(z.file('word/comments.xml'));
  assert.match(await z.file('word/_rels/document.xml.rels').async('string'), /relationships\/comments/);
  assert.match(await z.file('[Content_Types].xml').async('string'), /\/word\/comments\.xml/);
});

test('dadosParaConferencia lê ficha (com valor/página), decisão e pacote', () => {
  const d = C.dadosParaConferencia({
    processo: { numeroProcesso: '10012345620268260100', ativo: { nome: 'X' } },
    analise: { ficha: { autor: { nome: { valor: 'Maria', pagina: 1 } }, contratos: [{ numero: { valor: '123', pagina: 2 } }], pedidos: [{ tipo: { valor: 'dano_moral', pagina: 9 } }] },
      parecer: { decisao: { poloPassivo: { empresa: 'BANCO CREFISA S/A', cnpj: '61033106000186' }, contrato: { numero: '456' } } } },
    pacote: { empresas: [{ cnpj: '60779196000196' }, { cnpj: '61033106000186' }] },
  });
  assert.equal(d.parteAdversa, 'Maria');
  assert.deepEqual(d.contratos, ['123', '456']);
  assert.deepEqual(d.pedidos.map((x) => x.codigo), ['dano_moral']);
  assert.equal(d.cnpjsGrupo.length, 2);
});
