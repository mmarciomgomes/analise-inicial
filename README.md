> **Organização e deploy:** veja `deploy/analise-inicial.md` (raiz do repositório). Esta pasta (`server/analise/`) roda na VPS como
> serviço próprio. **A consulta agendada do jus.br pelo Chrome foi removida:** as outras ações da parte vêm da API pública do DJEN,
> por nome, e o perfil do advogado por OAB. As menções a jus.br/ponte/token abaixo são do desenho antigo.

# Gomjur — Análise Inicial (Crefisa)

Esteira que leva o processo da citação até a minuta de contestação, seguindo o **Manual Interno de Análise 2026.2**.
Tudo é desligado por padrão e ligado por escritório e por cliente.

```
cadastro → ingestão/OCR → ficha da inicial → diligências (base interna, comprovante, DJEN, jus.br)
→ triagem (LLM + regras do manual) → [advogado aprova] → pedido de subsídios (o advogado sobe no sistema do cliente) → [advogado anexa o retorno] → lê o checklist
→ parecer (SAG, trilha, prescrição, Toscana, estorno) → [advogado aprova] → minuta DOCX
```

## O que vem na pasta

| Caminho | O que é |
|---|---|
| `backend/analise-routes.js` | Rotas `/analise/*` para o `jur.js` (CommonJS, 1 linha para ligar) |
| `worker/analise.mjs` | Worker separado (como o `prazo.mjs`): fila de jobs, abertura automática, alertas de subsídios sem retorno |
| `worker/stages/*.mjs` | As 8 etapas + pós-processamento do jus.br |
| `shared/regras.js` | Motor de regras declarativas (JSON Logic + operadores de data) — sem dependências |
| `shared/decisao.js` | Triagem, matriz de subsídios, parecer, conexão/litispendência/coisa julgada |
| `shared/esteira.js` | Flags, configuração, fila de jobs, índices, cifragem |
| `pacotes/crefisa-2026.2.json` | **Tudo que é da Crefisa**: empresas/CNPJs, 26 teses, 11 preliminares, 33 regras, matriz de subsídios, modelos do pedido de subsídios, blocos da peça, prompts |
| `pacotes/crefisa-manual-2026.2.txt` | Texto do manual (vai para os prompts de triagem e parecer) |
| `jusbr/roteiro-claude-chrome.md` | Texto da tarefa agendada do Claude no Chrome (PC autenticado no jus.br) |
| `client/src/components/AnaliseTab.jsx` | Aba "Análise da Inicial" no processo |
| `client/src/pages/analise-config.js` | Tela de configuração por cliente e token do jus.br |
| `scripts/seed-pacote.mjs` | Instala o pacote e liga a análise para escritório/clientes |
| `shared/conferencia.js` | Conferência de peças .docx antes do protocolo (sobras de modelo, realce, coerência com o processo) |
| `scripts/conferir.mjs` | Conferência pela linha de comando (arquivo ou pasta; planilha CSV; cópia com comentários) |
| `frontend/ConferenciaPeca.jsx` | Botão/modal "Conferir peça" (Documentos anexados e aba Análise da Inicial) |
| `protocolo/conferencia-protocolo.js` | Portão do worker de protocolo: confere a peça principal antes de peticionar |
| `protocolo/worker.js` | Worker de protocolo 10.29.0 (o seu 10.28.1 + 12 linhas do portão) |
| `frontend/ConferenciaProtocolo.jsx` | Resultado no prazo + "Protocolar mesmo assim" |
| `test/` | 19 testes das regras do manual + simulação ponta a ponta (18 verificações) |

## Instalação

### 1. Backend (jur.js)

1. Copie esta pasta para dentro do projeto do `jur.js`, por exemplo em `./analise`.
2. Dependências (as que faltarem no projeto):
   ```bash
   npm i @aws-sdk/client-s3 @aws-sdk/client-textract ajv docx dotenv imapflow jszip mailparser mongodb nodemailer openai pdf-lib pdf-parse
   ```
3. No `jur.js`, **depois** de criar o `app` e de definir `getDb()`, e **antes** do `app.get("*", ...)`:
   ```js
   require('./analise/backend/analise-routes').registerAnaliseRoutes(app, { getDb });
   ```
4. `.env` (o mesmo do jur.js/prazo.mjs serve):
   ```bash
   MONGO_URI=...            # já existe
   DB_NAME=jur              # já existe
   OPENAI_API_KEY=...       # já existe no prazo.mjs
   ANALISE_CRYPTO_KEY=...   # openssl rand -hex 32  (cifra senhas das caixas e CPFs da fila)
   # opcionais
   ANALISE_LLM_MODEL=       # default: LLM_MODEL do prazo.mjs
   ANALISE_LLM_REASONING=medium
   ANALISE_CONCORRENCIA=2   # jobs em paralelo
   ANALISE_LLM_CONCURRENCY=3
   TEXTRACT_REGION=us-east-1
   S3_BUCKET_ANALISE=gomjur-br
   ANALISE_TRANSCRICAO_MODEL=gpt-4o-transcribe
   ```
5. Suba o worker:
   ```bash
   pm2 start analise/worker/analise.mjs --name analise
   # depurar 1 ciclo: node analise/worker/analise.mjs teste
   ```

### 2. Ligar para o escritório e os 2 clientes do grupo Crefisa

```bash
node analise/scripts/seed-pacote.mjs analise/pacotes/crefisa-2026.2.json \
  --escritorio <id do escritório> --cliente <id Crefisa CFI> --cliente <id Banco Crefisa> --modo sombra
```
Isso: instala o pacote, liga `escritorios.funcao.analiseInicial`, cria `analiseConfig` por cliente com todos os módulos e `ativoDesde = hoje`.
Escritório sem a flag não vê nada (rotas devolvem 403, o worker ignora, a aba não aparece).

Depois, na tela **Análise da Inicial — configuração**:
- **Gerar token da ponte** do jus.br (aparece uma única vez).

### 3. Front

- Copie `frontend/AnaliseTab.jsx` para `src/components/` e `frontend/AnaliseConfig.jsx` para `src/pages/analise-config.js`.
- Em `pages/processo.js`, ao lado da aba Cálculo (o snippet completo está no topo do `AnaliseTab.jsx`):
  ```jsx
  {analiseHabilitada && (
    <Tab eventKey="analise-tab" title="Análise da Inicial">
      {activeKey === "analise-tab" ? <AnaliseTab hostDB={hostDB} codigoEscritorio={codigoEscritorio} idProcesso={form?._id} userId={userId} /> : null}
    </Tab>
  )}
  ```
- Registre a rota `/analise-config` no menu de parâmetros.

### 4. PC do jus.br

1. Um PC (ou VM) sempre ligado, com um perfil do Chrome só para isso, logado no jus.br pela conta do advogado.
2. Cadastre o texto de `jusbr/roteiro-claude-chrome.md` como tarefa agendada do Claude com acesso a esse Chrome (sugestão: de hora em hora, dias úteis, 8h–19h), trocando `<URL_API>` e `<TOKEN>`.
3. Se a sessão expirar, a fila pausa e aparece um alerta (`analiseAlertas`). Alguém entra no portal e abre a ponte com `&liberar=1`.

## Como funciona cada decisão

- **O que é regra objetiva do manual está em `pacotes/crefisa-2026.2.json` → `regras`**, executado por código: polo passivo (CNPJs), conexão/litispendência/coisa julgada, gratuidade, captador, prescrição quinquenal/decenal com bloqueio do contrato, Toscana 23/08/2023, canal da fraude pela trilha, estorno > 5 anos, não é cliente, exibição genérica, gatilhos de acordo. Mudou o manual? Edite o pacote (tela ou JSON) — sem deploy.
- **A LLM só lê e classifica**: separa as peças, preenche a ficha (cada campo com página e trecho), escolhe teses dentro da taxonomia fechada, compara ações, lê subsídios e redige o parecer e a síntese dos fatos. A saída é validada contra JSON Schema; tese fora da taxonomia é descartada.
- **Score de ofensor**: proposta da seção 4.5 (`shared/util.js → SCORE_DEFAULT`), sobrescrevível por cliente. Marca manual sempre prevalece.
- **Revisão humana**: `sombra`/`assistido` = advogado aprova toda triagem; `automatico` = só exceções (confiança < mínima, alerta vermelho, conflito de teses, preliminar extintiva). Parecer e minuta são sempre revisados; nada é protocolado automaticamente.
- **Minuta**: montada pelos blocos do pacote. Os blocos marcados `[BLOCO APROVADO: ...]` são provisórios: **substitua pelos textos do escritório** antes de ligar o módulo de minuta para valer. Documentos bloqueados (ex.: contrato decenal) saem como "NÃO JUNTAR" com a providência.

## Conferência de peças (etapa 1 das minutas)

Lê o .docx e aponta o que não pode chegar ao juiz. **Bloqueio** impede o "ok"; **alerta** pede atenção.

| Regra | Nível | Exemplo |
|---|---|---|
| Variável não substituída | bloqueio | `VAR_VARA`, `{{autor}}` |
| Lacuna | bloqueio | `XXXXXXXX`, `05/XX/20XX`, `R$ xx` |
| Marcador entre colchetes | bloqueio | `[ADVOGADO]`, `[CPF DA INICIAL]`, `[BLOCO APROVADO: …]` |
| Instrução do modelo | bloqueio | `(APENAS QUANDO TIVER INADIMPLÊNCIA)`, linha `QUANDO FOR CONTRATOS PRESCRITOS…` |
| Recado interno | bloqueio | "falar comigo", "não esquecer de", "NÃO JUNTAR", "apagar antes de protocolar" |
| Realce | bloqueio no modo protocolo, alerta no rascunho | trecho marcado em amarelo |
| Texto em vermelho, comentários, alterações controladas, parágrafo repetido, linha `______` | alerta | |
| Singular/plural em aberto | info | `o(s) contrato(s)` |
| Nº do processo ausente | bloqueio | quando há processo vinculado |
| Parte ausente, CNPJ de outra empresa do grupo, CNPJ do polo ausente, contrato que não está na ficha, pedido da inicial sem impugnação | alerta | quando há Análise Inicial |

Olha corpo, notas de rodapé/fim, cabeçalhos e rodapés. Texto apagado com controle de alterações não conta.

- **Na esteira:** a minuta gerada já sai conferida (modo rascunho). O resultado aparece na aba Análise da Inicial, com o botão "Conferir a peça final antes do protocolo".
- **Em qualquer .docx do processo:** `POST /analise/conferir` com `docId` (ou `arquivoBase64` + `nomeArquivo`); `anotar: true` devolve a cópia com comentários do Word em cada ponto. O resultado fica em `conferenciasPeca` e um resumo em `documentosAnexados.conferencia` (para mostrar selo na lista).
- **Pela linha de comando:** `node scripts/conferir.mjs ./pecas --csv conferencia.csv --anotar ./saida --pacote pacotes/crefisa-2026.2.json`. Sai com código 1 se houver bloqueio.
- **Quem pode usar:** escritórios com `funcao.analiseInicial` **ou** só `funcao.conferenciaPeca = true` (para quem não usa a esteira).
- **Ajustes sem deploy** (`pacote.conferencia`): `pedidos` (expressão que mostra que cada pedido foi impugnado), `regrasExtras` (`{ id, padrao, severidade, mensagem }`), `desligar` (ids de regras), `modoPadrao`.
- Para usar o S3 do próprio jur.js: `registerAnaliseRoutes(app, { getDb, baixarArquivo: (doc) => Buffer })`.

## Conferência no protocolo (worker de peticionamento)

Antes de enviar ao pet-server/LOY, o worker baixa a peça principal (PDF ou .docx) e confere. **Não precisa de Análise
Inicial**: usa o prazo e o cadastro do processo — número do processo, números dos recursos/apensos
(`numeroProcessoHistorico`, `numeroProcessoHistoricoDetalhes`) e as partes (`ativo.nome`, `passivo.nome`). Se o
processo tiver Análise Inicial, entram também contratos, CNPJ do polo e pedidos.

- **Ligar por escritório:** `escritorios.funcao.conferenciaProtocolo = "alertar"` (confere e registra; protocola sempre)
  ou `"bloquear"` (peça com bloqueio vira **Manual**, `protocolo.motivoManual = "conferencia"`, com o motivo agrupado).
  Sugestão: 1 a 2 semanas em `alertar`, olhar `conferenciasPeca`, depois `bloquear`.
- **Ajustes (opcionais)** em `escritorios.conferenciaProtocolo`: `clientes` (só esses), `tiposIgnorar`
  (ex.: `["guia", "substabelecimento", "procuracao"]`), `regrasExtras`, `desligar`, `pedidos`.
- **Protocolar mesmo assim:** `POST /analise/conferencia-liberar { codigoEscritorio, prazoId, userId, motivo }` libera
  o arquivo atual (pelo hash) e devolve o prazo à fila. Trocou o arquivo, confere de novo.
- **Falha da conferência** (arquivo ilegível, sem biblioteca de PDF, S3 fora) nunca impede o protocolo: fica em
  `protocolo.conferencia.erro` e o envio segue.
- **PDF** não guarda realce nem cor: confere o texto. PDF digitalizado (sem texto) gera só um alerta.
- **Instalar no worker:** copie `shared/conferencia.js` e `protocolo/conferencia-protocolo.js` para a pasta do
  `worker.js`, aplique as mudanças do `protocolo/worker.js` (ou use-o) e rode `npm i pdfjs-dist`
  (testado com 6.2; Node 18 → `pdfjs-dist@4`). O jszip já vem com o docx-templates.
- Grava em `prazos.protocolo.conferencia` (resumo + 30 achados) e em `conferenciasPeca` (completo, `origem: "protocolo"`).

## Testes

```bash
npm test          # 19 testes das regras do manual + 20 da conferência (peças e protocolo) — Node puro, sem banco
npm run simular   # simulação ponta a ponta: rode numa CÓPIA da pasta (troca node_modules por dublês)
```
A simulação percorre um caso de fraude em consignado: conexão pela base interna, comprovante repetido de outro CPF,
jus.br por CPF e OAB, advogado virando ofensor, e-mail com código, resposta pelo IMAP, parecer Toscana até 23/08/2023,
complemento pedindo a gravação, minuta DOCX com conferência automática, lembrete D+2 e pausa por login expirado.

## Premissas sobre o seu código (conferir antes de ligar)

| Premissa | Onde | Se for diferente |
|---|---|---|
| Cliente do processo em `processos.idCliente` (confirmado no jur.js de 23/10) | `shared/esteira.js → configDoProcesso` | — |
| CPF da parte contrária em `processos.extraFields.documentoOutraParte` (layout Crefisa já grava "Documento Adverso Principal" aí) | diligências | ajustar o campo |
| Prazo de contestação em `prazos` (procura "contesta" em tipo/descrição; data em `dataPrazo`/`dataFatal`/`data`) | `worker/stages/subsidios.mjs → prazoContestacao` | ajustar a consulta |
| Texto das publicações em `publicacoes.texto`/`teor` | `worker/stages/parecer.mjs` | ajustar os campos |
| Documentos criados pela análise (subsídios do e-mail e minuta) entram em `documentosAnexados` sem pasta (`folderId: null`) | IMAP e minuta | se a aba Documentos exigir pasta, gravar o `folderId` da pasta padrão |
| Endereço e nascimento da parte: só existem na ficha da análise (não em `processos`) | higienização | se o cadastro tiver esses campos, incluir na comparação |

## Custos e limites

- LLM: cerca de 7 a 9 chamadas por processo (classificação, ficha, comparação, triagem, checklist, leitura dos subsídios, parecer, fatos). O uso fica em `analiseLlmUso`.
- O jus.br avisa que a integração dos tribunais ainda é parcial: "nada encontrado" não prova que não há outras ações.
- A consulta usa a conta de um advogado: volume moderado e nunca automatizar login.

## Segurança

- Senhas de SMTP/IMAP e CPFs da fila ficam cifrados (AES-256-GCM, `ANALISE_CRYPTO_KEY`). O CPF só aparece em claro na página da ponte, para o item reservado.
- Observação sobre o `jur.js` atual: a rota de recuperação de senha tem usuário e senha de SMTP escritos no código. Vale mover para o `.env` e trocar essa senha.
