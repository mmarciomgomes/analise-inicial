// worker/lib/schemas.mjs — formatos de saída da LLM (JSON Schema, validados com Ajv).
// Todo campo factual vem como {valor, pagina, trecho}: a tela mostra a origem e o advogado confere.

const ev = (tipoValor = {}) => ({
  type: ['object', 'null'],
  properties: {
    valor: tipoValor.type ? tipoValor : { type: ['string', 'number', 'boolean', 'null'] },
    pagina: { type: ['integer', 'null'], description: 'Página do PDF (marcador [[p.N]])' },
    doc: { type: ['string', 'null'], description: 'id do documento (marcador [[doc:ID]])' },
    trecho: { type: ['string', 'null'], description: 'Trecho literal curto (até 200 caracteres) que comprova o valor' },
  },
  required: ['valor'],
});
const evStr = () => ev({ type: ['string', 'null'] });
const evBool = () => ev({ type: ['boolean', 'null'] });
const evNum = () => ev({ type: ['number', 'null'] });

export const TIPOS_PECA = [
  'peticao_inicial', 'procuracao', 'documento_identidade', 'comprovante_residencia', 'declaracao_hipossuficiencia',
  'declaracao_residencia_terceiro', 'extrato_bancario', 'extrato_inss', 'contrato', 'relatorio_scr', 'extrato_spc_serasa',
  'print_serasa_limpa_nome', 'fatura_cartao', 'boletim_ocorrencia', 'reclamacao_administrativa', 'decisao_judicial',
  'tela_sag', 'trilha_contratacao', 'demonstrativo_credito', 'demonstrativo_debito', 'ret', 'tela_nfc', 'termo_refin',
  'audio_transcricao', 'outro',
];

export const schemaClassificacao = {
  type: 'object',
  properties: {
    segmentos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          paginaInicial: { type: 'integer', minimum: 1 },
          paginaFinal: { type: 'integer', minimum: 1 },
          tipo: { type: 'string', enum: TIPOS_PECA },
          descricao: { type: 'string' },
        },
        required: ['docId', 'paginaInicial', 'paginaFinal', 'tipo'],
      },
    },
  },
  required: ['segmentos'],
};

export const schemaFicha = {
  type: 'object',
  properties: {
    autor: {
      type: 'object',
      properties: {
        nome: evStr(), cpf: evStr(), dataNascimento: evStr(), profissao: evStr(),
        menorOuIncapaz: evBool(),
        representante: { type: ['object', 'null'], properties: { nome: evStr(), cpf: evStr(), vinculo: evStr() } },
        enderecoDeclarado: evStr(), cepDeclarado: evStr(), cidadeUf: evStr(),
        beneficioInss: { type: ['object', 'null'], properties: { numero: evStr(), especie: evStr() } },
        recebeBeneficioPeloBancoCrefisa: evBool(),
      },
      required: ['nome', 'cpf'],
    },
    advogados: {
      type: 'array',
      items: { type: 'object', properties: { nome: { type: 'string' }, oab: { type: ['string', 'null'] }, uf: { type: ['string', 'null'] }, email: { type: ['string', 'null'] }, pagina: { type: ['integer', 'null'] } }, required: ['nome'] },
    },
    poloPassivo: {
      type: 'array',
      items: { type: 'object', properties: { nome: { type: 'string' }, cnpj: { type: ['string', 'null'] }, pagina: { type: ['integer', 'null'] } }, required: ['nome'] },
    },
    contratos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          numero: { type: ['string', 'null'] },
          produto: { type: ['string', 'null'], enum: ['pessoal', 'consignado', 'cartao', 'conta', 'inss', 'cheque_especial', 'outro', null] },
          dataContratacao: { type: ['string', 'null'], description: 'aaaa-mm-dd' },
          valor: { type: ['number', 'null'] },
          qtdParcelas: { type: ['integer', 'null'] },
          valorParcela: { type: ['number', 'null'] },
          canalAlegado: { type: ['string', 'null'] },
          pagina: { type: ['integer', 'null'] }, doc: { type: ['string', 'null'] }, trecho: { type: ['string', 'null'] },
        },
      },
    },
    fatos: {
      type: 'object',
      properties: {
        reconheceContratacao: ev({ type: ['string', 'null'], enum: ['sim', 'nao', 'parcial', 'nao_informado', null] }),
        valoresDescontados: { type: 'array', items: { type: 'object', properties: { valor: { type: 'number' }, pagina: { type: ['integer', 'null'] } }, required: ['valor'] } },
        ondeOcorreDesconto: ev({ type: ['string', 'null'], enum: ['beneficio', 'conta', 'folha', 'cartao', 'boleto', 'nao_informado', null] }),
        dataScr: evStr(),
        negativacaoAlegada: ev({ type: ['string', 'null'], enum: ['limpa_nome', 'scr', 'orgaos_protecao', 'nao', null] }),
        alegaQuitacao: evBool(),
        resumo: { type: ['string', 'null'], description: '3 a 5 linhas com o núcleo dos fatos narrados' },
      },
    },
    pedidos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['declaratoria_inexistencia', 'repeticao_indebito', 'repeticao_em_dobro', 'dano_moral', 'revisao_juros', 'exibicao_documentos', 'cancelamento_debito_automatico', 'cancelamento_contrato', 'repactuacao', 'exclusao_negativacao', 'tutela_urgencia', 'outro'] },
          valor: { type: ['number', 'null'] },
          descricao: { type: ['string', 'null'] },
          pagina: { type: ['integer', 'null'] },
        },
        required: ['tipo'],
      },
    },
    processo: {
      type: 'object',
      properties: {
        juizo: evStr(), uf: evStr(), justica: ev({ type: ['string', 'null'], enum: ['estadual', 'federal', null] }),
        valorCausa: evNum(), pedeTutela: evBool(), pedeGratuidade: evBool(), caixaNoPolo: evBool(), dataAjuizamento: evStr(),
      },
    },
    comprovanteResidencia: {
      type: ['object', 'null'],
      properties: {
        titular: evStr(), endereco: evStr(), cep: evStr(), cidadeUf: evStr(), emissor: evStr(), dataEmissao: evStr(),
        mesReferencia: evStr(), codigoClienteOuInstalacao: evStr(),
      },
    },
    observacoes: { type: 'array', items: { type: 'string' } },
  },
  required: ['autor', 'advogados', 'poloPassivo', 'contratos', 'fatos', 'pedidos', 'processo'],
};

export const schemaComparacao = {
  type: 'object',
  properties: {
    comparacoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          numero: { type: 'string' },
          mesmasPartes: { type: 'boolean' },
          mesmaEmpresa: { type: 'boolean' },
          mesmoPedido: { type: ['boolean', 'null'] },
          mesmaCausaDePedir: { type: ['boolean', 'null'] },
          faseConhecimento: { type: ['boolean', 'null'] },
          justificativa: { type: 'string' },
        },
        required: ['numero', 'mesmasPartes', 'mesmaEmpresa', 'mesmoPedido', 'mesmaCausaDePedir', 'justificativa'],
      },
    },
  },
  required: ['comparacoes'],
};

export function schemaTriagem(idsTeses, produtos) {
  return {
    type: 'object',
    properties: {
      produto: { type: 'string', enum: [...produtos, 'nao_identificado'] },
      nucleo: { type: 'string', description: 'Núcleo da controvérsia em 1 frase' },
      respostas: {
        type: 'object',
        properties: {
          reconheceContratacao: { type: 'string', enum: ['sim', 'nao', 'parcial', 'nao_informado'] },
          discute: { type: 'string', enum: ['existencia_do_contrato', 'condicoes_do_contrato', 'clausulas_juros_encargos', 'cobranca_desconto', 'interromper_debito', 'negativacao', 'exibicao', 'repactuacao', 'outro'] },
          trechos: { type: 'array', items: { type: 'object', properties: { pagina: { type: ['integer', 'null'] }, trecho: { type: 'string' } }, required: ['trecho'] } },
        },
        required: ['reconheceContratacao', 'discute'],
      },
      teses: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            tese: { type: 'string', enum: idsTeses },
            papel: { type: 'string', enum: ['principal', 'subsidiaria'] },
            confianca: { type: 'number', minimum: 0, maximum: 1 },
            motivo: { type: 'string' },
            pagina: { type: ['integer', 'null'] },
            trecho: { type: ['string', 'null'] },
          },
          required: ['tese', 'papel', 'confianca', 'motivo'],
        },
      },
      decisaoJudicialNaInicial: { type: ['object', 'null'], properties: { determinouExibicao: { type: 'boolean' }, sancao: { type: 'boolean' }, descricao: { type: 'string' } } },
      precisaHumano: { type: 'boolean', description: 'true se o caso foge do manual ou há dúvida relevante' },
      observacoes: { type: 'array', items: { type: 'string' } },
    },
    required: ['produto', 'nucleo', 'respostas', 'teses', 'precisaHumano'],
  };
}

export const schemaChecklist = {
  type: 'object',
  properties: {
    documentos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          tipo: { type: 'string', enum: TIPOS_PECA },
          atendeItens: { type: 'array', items: { type: 'string' }, description: 'Itens da lista pedida que este documento atende (texto exato do item)' },
          observacao: { type: ['string', 'null'] },
        },
        required: ['docId', 'tipo', 'atendeItens'],
      },
    },
  },
  required: ['documentos'],
};

export const schemaLeituraSubsidios = {
  type: 'object',
  properties: {
    sag: {
      type: 'object',
      properties: {
        consultado: { type: 'boolean', description: 'false se não veio tela do SAG' },
        encontrado: { type: ['boolean', 'null'], description: 'false se o SAG não mostra nenhum contrato no CPF' },
        contratos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              numero: { type: ['string', 'null'] }, produto: { type: ['string', 'null'] },
              dataCelebracao: { type: ['string', 'null'], description: 'aaaa-mm-dd' },
              ultimoPagamento: { type: ['string', 'null'], description: 'aaaa-mm-dd' },
              status: { type: ['string', 'null'], enum: ['liquidado', 'aberto', null] },
              valor: { type: ['number', 'null'] }, parcelas: { type: ['integer', 'null'] }, valorParcela: { type: ['number', 'null'] },
              houveAtraso: { type: ['boolean', 'null'] },
              doc: { type: ['string', 'null'] }, pagina: { type: ['integer', 'null'] }, trecho: { type: ['string', 'null'] },
            },
          },
        },
      },
      required: ['consultado', 'contratos'],
    },
    contrato: {
      type: ['object', 'null'],
      properties: {
        numero: evStr(), empresaContratante: evStr(), contratante: evStr(), contratadoPeloRepresentante: evBool(),
        assinatura: ev({ type: ['string', 'null'], enum: ['fisica', 'digital', 'a_rogo', 'ausente', null] }),
        digital: evBool(), testemunhas: { type: 'array', items: { type: 'string' } },
        taxaMensal: evNum(), cetAnual: evNum(),
      },
    },
    trilha: {
      type: ['object', 'null'],
      properties: {
        canal: ev({ type: ['string', 'null'], enum: ['filial', 'filial_rogo', 'whats', 'web', 'app', 'toscana', 'refin', null] }),
        dataHora: evStr(), ip: evStr(), geolocalizacao: evStr(), selfie: evBool(), confirmacao: evBool(), observacao: { type: ['string', 'null'] },
      },
    },
    gravacao: { type: ['object', 'null'], properties: { houveConfirmacao: evBool(), quemConfirmou: evStr(), resumo: { type: ['string', 'null'] } } },
    negativacao: { type: ['object', 'null'], properties: { spc: evBool(), serasa: evBool(), contratoOrigem: evStr(), data: evStr() } },
    conta: { type: ['object', 'null'], properties: { natureza: evStr(), indicadaPeloAutor: evBool(), usoChequeEspecial: evBool() } },
    pendencias: { type: 'array', items: { type: 'string' } },
  },
  required: ['sag'],
};

export const schemaParecer = {
  type: 'object',
  properties: {
    resumo: { type: 'string', description: '1 parágrafo: conclusão objetiva (tese principal, subsidiárias, documentos)' },
    preliminares: { type: 'array', items: { type: 'object', properties: { preliminar: { type: 'string' }, fundamento: { type: 'string' } }, required: ['preliminar', 'fundamento'] } },
    teses: { type: 'array', items: { type: 'object', properties: { tese: { type: 'string' }, papel: { type: 'string' }, fundamento: { type: 'string' }, provas: { type: 'array', items: { type: 'string' } } }, required: ['tese', 'fundamento'] } },
    documentos: { type: 'object', properties: { juntar: { type: 'array', items: { type: 'string' } }, naoJuntar: { type: 'array', items: { type: 'string' } } } },
    riscos: { type: 'array', items: { type: 'string' } },
    pendencias: { type: 'array', items: { type: 'string' } },
    recomendacaoAcordo: { type: ['string', 'null'] },
  },
  required: ['resumo', 'teses', 'riscos', 'pendencias'],
};

export const schemaFatos = {
  type: 'object',
  properties: { sinteseFatos: { type: 'string' } },
  required: ['sinteseFatos'],
};

export const schemaDecisaoJudicial = {
  type: 'object',
  properties: {
    determinouExibicao: { type: 'boolean' },
    sancao: { type: 'boolean', description: 'multa, busca e apreensão, "sob as penas da lei" ou art. 400 do CPC' },
    tutelaDeferida: { type: ['boolean', 'null'] },
    descricao: { type: 'string' },
  },
  required: ['determinouExibicao', 'sancao', 'descricao'],
};
