// Portão de conferência do worker de protocolo (sem Análise Inicial). Rodar: node --test test/conferencia-protocolo.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId, Db } = require('./sim/fakemongo');
const P = require('../protocolo/conferencia-protocolo');
const C = require('../shared/conferencia');

const tentar = (id) => { try { return require(id); } catch { return null; } };
const JSZip = [tentar('jszip'), process.env.JSZIP_PATH && tentar(process.env.JSZIP_PATH)].find((m) => typeof m?.loadAsync === 'function');
const pular = !JSZip && 'jszip não instalado (npm i, ou JSZIP_PATH=/caminho/jszip)';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function docx(linhas) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${linhas.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

const PRINCIPAL = '10012345620268260100';
const RECURSO = '20098765420268260000';
async function cenario({ funcao, ajustes, proc = {}, analise } = {}) {
  global.__FAKE_DB = undefined;
  const db = new Db();
  const ce = new ObjectId();
  const esc = { _id: ce, funcao: { peticionar: 'peticionarJusbr', ...funcao }, conferenciaProtocolo: ajustes };
  const procId = new ObjectId();
  await db.collection('processos').insertOne({
    _id: procId, codigoEscritorio: ce, numeroProcesso: PRINCIPAL, idCliente: 'cli1',
    ativo: { nome: 'MARIA DA SILVA SOUZA' }, passivo: { nome: 'BANCO CREFISA S/A' },
    numeroProcessoHistoricoDetalhes: [{ _id: new ObjectId(), numero: RECURSO, tipoVinculo: 'RECURSO' }], ...proc,
  });
  if (analise) await db.collection('analiseInicial').insertOne({ idProcesso: procId, ...analise });
  const prazo = { _id: new ObjectId(), codigoEscritorio: String(ce), numeroProcesso: PRINCIPAL, status: 'Processando', protocolo: {} };
  await db.collection('prazos').insertOne(prazo);
  return { db, esc, prazo, procId };
}
const payload = { tipoDocumentoPrincipal: 'Petição', arquivoPrincipal: { originalName: 'contestacao.docx', s3Key: 'k' } };
const carregar = (buf) => async () => ({ buffer: buf, filename: 'contestacao.docx' });
const rodar = (c, buf, extra = {}) => P.conferirAntesDoProtocolo(c.db, { collName: 'prazos', doc: c.prazo, payload, esc: c.esc, carregarArquivo: carregar(buf), ObjectId, ...extra });
const BOA = ['Processo nº 1001234-56.2026.8.26.0100', 'BANCO CREFISA S/A, nos autos da ação movida por MARIA DA SILVA SOUZA, vem apresentar contestação.'];

test('desligado: nada é conferido nem gravado', { skip: pular }, async () => {
  const c = await cenario();
  const r = await rodar(c, await docx(['VAR_VARA']));
  assert.deepEqual(r, { seguir: true, pulado: 'desligado' });
  assert.equal((await c.db.collection('conferenciasPeca').find({}).toArray()).length, 0);
});

test('alertar: peça com sobra segue para o protocolo, mas fica registrada', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'alertar' } });
  const r = await rodar(c, await docx([...BOA, 'contrato nº XXXXXXXX (CONFIRMAR SE HÁ PEDIDO NA INICIAL)']));
  assert.equal(r.seguir, true);
  const p = await c.db.collection('prazos').findOne({ _id: c.prazo._id });
  assert.equal(p.protocolo.conferencia.ok, false);
  assert.equal(p.protocolo.conferencia.bloqueios, 2);
  assert.equal(p.protocolo.conferencia.barrou, false);
  assert.equal((await c.db.collection('conferenciasPeca').find({}).toArray()).length, 1);
});

test('bloquear: peça com sobra vira Manual com o motivo; peça limpa segue', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' } });
  const r = await rodar(c, await docx([...BOA, 'EXCELENTÍSSIMO JUIZ DA VAR_VARA']));
  assert.equal(r.seguir, false);
  assert.match(r.motivo, /1 bloqueio/);
  await P.marcarBarradoPelaConferencia(c.db, 'prazos', c.prazo, r.motivo);
  const p = await c.db.collection('prazos').findOne({ _id: c.prazo._id });
  assert.equal(p.status, 'Manual');
  assert.equal(p.protocolo.motivoManual, 'conferencia');
  assert.equal(p.protocolo.conferencia.barrou, true);

  const limpa = await rodar(c, await docx(BOA));
  assert.equal(limpa.seguir, true);
  assert.equal(limpa.resultado.ok, true);
});

test('true equivale a "bloquear"', () => {
  assert.equal(P.modoDoEscritorio({ funcao: { conferenciaProtocolo: true } }), 'bloquear');
  assert.equal(P.modoDoEscritorio({ funcao: { conferenciaProtocolo: 'x' } }), null);
});

test('liberação manual vale só para o mesmo arquivo (hash)', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' } });
  const ruim = await docx([...BOA, 'VAR_VARA']);
  const r1 = await rodar(c, ruim);
  const sha = (await c.db.collection('prazos').findOne({ _id: c.prazo._id })).protocolo.conferencia.sha256;
  c.prazo.protocolo = { conferenciaLiberada: { sha256: sha } };
  const r2 = await rodar(c, ruim);
  assert.equal(r1.seguir, false);
  assert.equal(r2.seguir, true);
  const outro = await rodar(c, await docx([...BOA, 'VAR_COMARCA']));
  assert.equal(outro.seguir, false, 'arquivo trocado é conferido de novo');
});

test('sem Análise Inicial: aceita o número do recurso vinculado; número de outro processo bloqueia; partes do cadastro', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' } });
  const doRecurso = await rodar(c, await docx(['Recurso nº 2009876-54.2026.8.26.0000', 'MARIA DA SILVA SOUZA']));
  assert.equal(doRecurso.seguir, true);
  const trocado = await rodar(c, await docx(['Processo nº 0000001-11.2025.8.26.0001', 'JOÃO NINGUÉM']));
  assert.equal(trocado.seguir, false);
  const regras = trocado.resultado.achados.map((a) => a.regra);
  assert.ok(regras.includes('processoAusente'));
  assert.ok(regras.includes('partesAusentes'));
});

test('com Análise Inicial (opcional): contratos e pedidos entram na conferência', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'alertar' }, analise: { ficha: { contratos: [{ numero: '123456789' }], pedidos: [{ tipo: 'dano_moral' }] } } });
  await c.db.collection('analiseConfig').insertOne({ codigoEscritorio: c.esc._id, clienteId: 'cli1', pacoteChave: 'crefisa' });
  await c.db.collection('pacotesAnalise').insertOne({ chave: 'crefisa', codigoEscritorio: null, conferencia: { pedidos: { dano_moral: { nome: 'Danos morais', defesa: 'dano moral' } } } });
  const r = await rodar(c, await docx([...BOA, 'O contrato nº 999888777 é válido.']));
  const regras = r.resultado.achados.map((a) => a.regra);
  assert.ok(regras.includes('contratoDesconhecido'));
  assert.ok(regras.includes('pedidoSemImpugnacao'));
});

test('tipos ignorados e clientes fora da lista não são conferidos', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' }, ajustes: { tiposIgnorar: ['guia', 'substabelec'] } });
  const r = await P.conferirAntesDoProtocolo(c.db, { collName: 'prazos', doc: c.prazo, payload: { ...payload, tipoDocumentoPrincipal: 'Substabelecimento' }, esc: c.esc, carregarArquivo: carregar(await docx(['VAR_X'])), ObjectId });
  assert.match(r.pulado, /tipo ignorado/);
  const c2 = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' }, ajustes: { clientes: ['outro'] } });
  assert.equal((await rodar(c2, await docx(['VAR_X']))).pulado, 'cliente fora da lista');
});

test('falha da conferência nunca impede o protocolo', { skip: pular }, async () => {
  const c = await cenario({ funcao: { conferenciaProtocolo: 'bloquear' } });
  const r = await rodar(c, null, { carregarArquivo: async () => { throw new Error('S3 fora'); } });
  assert.equal(r.seguir, true);
  const p = await c.db.collection('prazos').findOne({ _id: c.prazo._id });
  assert.match(p.protocolo.conferencia.erro, /S3 fora/);
  const ilegivel = await rodar(c, Buffer.from('não é pdf nem docx'));
  assert.equal(ilegivel.seguir, true);
});

test('PDF: linhas viram parágrafos; instrução quebrada em duas linhas é achada; título em caixa alta fica separado', async () => {
  const paginas = [
    'EXCELENTÍSSIMO SENHOR DOUTOR JUIZ DE DIREITO\nProcesso nº 1001234-56.2026.8.26.0100\nA parte autora alega que firmou o contrato\nnº 123 com a ré (CONFIRMAR SE HÁ PEDIDO\nNA INICIAL) e pede a declaração de inexis-\ntência do débito.\n\nDA RETIFICAÇÃO DO POLO PASSIVO\nAPENAS QUANDO A PARTE TIVER NEGATIVADA\nPOR OUTRAS INSTITUIÇÕES\nTexto normal seguinte.',
    'Página 2 sem nada de especial.',
  ];
  const paras = C.paragrafosDePaginas(paginas);
  assert.ok(paras.some((p) => p.texto.includes('inexistência do débito')), 'hifenização juntada');
  const r = await C.conferirPdf(Buffer.from('%PDF-1.4'), { extrairPdf: async () => paginas, dados: { numeroProcesso: PRINCIPAL } });
  const inst = r.achados.filter((a) => a.regra === 'instrucao');
  assert.equal(inst.length, 2, JSON.stringify(inst.map((a) => a.valor)));
  assert.equal(inst[0].local.pagina, 1);
  assert.ok(!r.achados.some((a) => a.regra === 'processoAusente'));
  assert.equal(r.formato, 'pdf');
});

test('PDF digitalizado (sem texto): alerta e não acusa número/parte ausentes', async () => {
  const r = await C.conferirPdf(Buffer.from('%PDF-1.4'), { extrairPdf: async () => ['', ' '], dados: { numeroProcesso: PRINCIPAL, partes: ['MARIA'] } });
  assert.ok(r.ok);
  assert.deepEqual(r.achados.map((a) => a.regra), ['semTexto']);
});
