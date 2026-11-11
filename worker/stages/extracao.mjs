// Etapa 3 — extração da Ficha da Inicial (cada campo com página e trecho).
import { chamarEstruturado } from '../lib/llm.mjs';
import { schemaFicha } from '../lib/schemas.mjs';
import { textoComMarcadores } from '../lib/docs.mjs';
import { E, U, paginasDoSegmento } from '../lib/contexto.mjs';

// anexos que ajudam a preencher a ficha (até 3 páginas de cada)
const ANEXOS_UTEIS = ['procuracao', 'documento_identidade', 'comprovante_residencia', 'declaracao_residencia_terceiro', 'extrato_inss', 'extrato_bancario', 'contrato', 'relatorio_scr', 'extrato_spc_serasa', 'print_serasa_limpa_nome', 'decisao_judicial'];

export async function executar(ctx) {
  const { db, processo, analise } = ctx;
  await ctx.estado(E.ESTADOS.EXTRACAO);
  const segs = analise?.ingestao?.segmentos || [];
  const inicial = segs.filter((s) => s.tipo === 'peticao_inicial');
  if (!inicial.length) throw new Error('Ingestão sem petição inicial.');

  const partes = [];
  for (const s of inicial) partes.push({ docId: s.docId, titulo: 'PETIÇÃO INICIAL', paginas: await paginasDoSegmento(db, s) });
  for (const s of segs.filter((x) => ANEXOS_UTEIS.includes(x.tipo))) {
    const pags = await paginasDoSegmento(db, { ...s, paginaFinal: Math.min(s.paginaFinal, s.paginaInicial + 2) });
    partes.push({ docId: s.docId, titulo: `ANEXO: ${s.tipo}`, paginas: pags.map((p) => ({ ...p, texto: p.texto.slice(0, 5000) })) });
  }
  const texto = textoComMarcadores(partes, 160000);

  const { dados: ficha, modelo } = await chamarEstruturado({
    sistema: `${ctx.pacote.prompts?.extracao || ''}\nEmpresas do cliente: ${(ctx.pacote.empresas || []).map((e) => `${e.nome} (CNPJ ${e.cnpj})`).join('; ')}.\nUse as marcas [[doc:ID]] e [[p.N]] para indicar doc e página de cada evidência.`,
    usuario: `Processo nº ${processo.numeroProcessoFull || processo.numeroProcesso}.\nCPF cadastrado no sistema para a parte contrária: ${processo.extraFields?.documentoOutraParte || 'não informado'}.\n\n${texto}`,
    nome: 'registrar_ficha', descricao: 'Registra a Ficha da Inicial', schema: schemaFicha, registrarUso: ctx.registrarUso,
  });

  // CPF: confere com o cadastro e valida dígitos
  const cpfFicha = U.soDigitos(ficha?.autor?.cpf?.valor);
  const cpfCadastro = U.cpfDoTexto(processo.extraFields?.documentoOutraParte);
  const alertas = [];
  if (cpfFicha && !U.cpfValido(cpfFicha)) alertas.push({ nivel: 'vermelho', texto: `CPF da inicial (${U.formatarCpf(cpfFicha)}) tem dígito verificador inválido.` });
  if (cpfFicha && cpfCadastro && cpfFicha !== cpfCadastro) alertas.push({ nivel: 'vermelho', texto: `CPF da inicial (${U.formatarCpf(cpfFicha)}) difere do cadastro do processo (${U.formatarCpf(cpfCadastro)}).` });
  const cpf = cpfFicha || cpfCadastro || null;

  const textoInicial = partes.filter((p) => p.titulo === 'PETIÇÃO INICIAL').flatMap((p) => p.paginas.map((x) => x.texto)).join('\n');
  await ctx.salvar({
    ficha,
    cpfHash: cpf ? U.hashCurto(cpf) : null,
    oabsAdversas: (ficha.advogados || []).filter((a) => a.oab).map((a) => `${U.soDigitos(a.oab)}/${String(a.uf || '').toUpperCase()}`),
    assinaturaInicial: U.assinaturaTexto(textoInicial),
    extracao: { modelo, em: new Date(), alertas, versaoManual: ctx.pacote.versao },
  });
  await E.enfileirar(db, { codigoEscritorio: processo.codigoEscritorio, idProcesso: processo._id, etapa: 'diligencias', prioridade: 3 });
  return { cpf: !!cpf, advogados: (ficha.advogados || []).length };
}
