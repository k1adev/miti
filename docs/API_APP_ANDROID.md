# Contrato de API — app Android (Faturamento + Atendimento)

Documentação de referência para um cliente mobile consumir o **mesmo backend** do Miti, sem alterar o comportamento do sistema web. Baseada nos usos atuais em `SalesReport.js`, `SalesReportPage.js`, `Atendimento.js` e `FloatingQuestions.js`.

## Base e autenticação

| Item | Valor |
|------|--------|
| **Produção (exemplo)** | `https://miti.fly.dev` |
| **Protocolo** | HTTPS |
| **Formato** | JSON (`Content-Type: application/json` nos POST/PUT com corpo) |

Todas as rotas abaixo ficam sob `/api/...` e **exigem JWT**, exceto login. O servidor aplica middleware global: requisições sem token válido recebem `401` / `403` conforme o caso.

### Login

```http
POST /api/login
Content-Type: application/json

{ "email": "...", "password": "..." }
```

**Resposta (200):** `{ "token": "<JWT>", "user": { "id", "name", "email", "role" } }`  
O JWT expira em **8 horas** (comportamento atual do servidor).

### Quem sou (opcional no app)

```http
GET /api/me
Authorization: Bearer <token>
```

**Resposta:** `{ "id", "name", "email", "role" }`

### Cabeçalho obrigatório

```http
Authorization: Bearer <token>
```

No app Android, guardar o token de forma segura (ex.: EncryptedSharedPreferences) e anexar em **todas** as chamadas à API.

---

## Parte 1 — Faturamento (Relatório de vendas)

Telas equivalentes a **Relatório → Vendas** (`SalesReport.js`). Os dados vêm de **notas expedidas** agregadas por marketplace e SKU.

### 1.1 Listar contas Bling (filtro “conta” no relatório)

Usado para montar o seletor de conta (`activeAccountId`); resposta traz contas cadastradas.

```http
GET /api/bling/accounts
Authorization: Bearer <token>
```

**Resposta:** `{ "accounts": [ { "id", "name", ... } ] }` (campos adicionais podem existir).

### 1.2 Relatório agregado (faturamento por marketplace e SKU)

```http
GET /api/reports/sales?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&marketplace=<opcional>&accountId=<opcional>
Authorization: Bearer <token>
```

| Query | Obrigatório | Descrição |
|-------|-------------|-----------|
| `dataInicio` | Recomendado | Início do período |
| `dataFim` | Recomendado | Fim do período |
| `marketplace` | Não | Filtra por nome (substring, case-insensitive), ex.: `Mercado Livre` |
| `accountId` | Não | ID da conta Bling; omitir ou usar lógica “todas” conforme o web (`all` = não enviar) |

**Resposta (200):**

```json
{
  "marketplaces": [
    {
      "marketplace": "Mercado Livre",
      "pedidos": 0,
      "faturamento": 0,
      "itens": 0,
      "skus": [
        { "sku": "...", "title": "...", "quantidade": 0, "faturamento": 0 }
      ]
    }
  ]
}
```

No cliente web, totais de cards (pedidos, itens, ticket médio) são **derivados** desse JSON no front.

### 1.3 Lista de pedidos (notas) no período

Útil para exportação por pedido ou segunda tela.

```http
GET /api/reports/sales/orders?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&marketplace=<opcional>&accountId=<opcional>
Authorization: Bearer <token>
```

**Resposta (200):** `{ "orders": [ { "marketplace", "nota_id", "numero", "data", "itens", "faturamento" }, ... ] }`

### 1.4 Export Excel (binário)

```http
GET /api/export/sales.xlsx?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&marketplace=<opcional>
Authorization: Bearer <token>
```

**Resposta:** arquivo **XLSX** (corpo binário). No Android, usar `responseType: arraybuffer` ou equivalente e salvar/abrir o arquivo.

> **Nota:** No código atual, o export XLSX não repete o parâmetro `accountId` da mesma forma que o relatório tabular; alinhar com o backend se precisar do mesmo filtro de conta.

---

## Parte 2 — Atendimento (pré-venda / perguntas Mercado Livre)

Equivalente à tela **Atendimento** e ao widget **FloatingQuestions**.

### 2.1 Listar perguntas

```http
GET /api/ml/questions?limit=50&status=<opcional>&accountId=<opcional>
Authorization: Bearer <token>
```

| Query | Descrição |
|-------|-----------|
| `limit` | Ex.: `50` |
| `status` | Ex.: `UNANSWERED`, `ANSWERED` (valores aceitos pela API ML via backend) |
| `accountId` | Filtra por conta ML interna do Miti |

**Resposta (200):** `{ "total", "questions": [...], "accounts": [ { "id", "name" } ] }`

Cada pergunta inclui campos da API ML e metadados adicionados pelo servidor, por exemplo:

- `_accountId` — **obrigatório** para responder/excluir com a conta correta  
- `_accountName`, `_marketplace`, `_item` (enriquecimento)

### 2.2 Contador de não respondidas (badge / notificação)

```http
GET /api/ml/questions/count
Authorization: Bearer <token>
```

**Resposta:** `{ "unanswered": <number> }`

### 2.3 Responder pergunta

```http
POST /api/ml/questions/{questionId}/answer
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "Texto da resposta", "accountId": <número — usar question._accountId> }
```

**Respostas de erro:** o servidor pode retornar `error`, `details` e `hint` (ex.: permissões OAuth no Mercado Livre).

### 2.4 Excluir pergunta

```http
DELETE /api/ml/questions/{questionId}?accountId=<número>
Authorization: Bearer <token>
```

### 2.5 Autocomplete de anúncios (tecla `#` na resposta)

```http
GET /api/ml/items/search-autocomplete?q=<termo>&accountId=<opcional>
Authorization: Bearer <token>
```

**Resposta:** array de itens (ex.: `ml_item_id`, `title`, `permalink`, …).

### 2.6 Respostas rápidas (usuário)

```http
GET /api/user/quick-replies
Authorization: Bearer <token>
```

```http
PUT /api/user/quick-replies
Authorization: Bearer <token>
Content-Type: application/json

{ "quickReplies": [ { "title": "Atalho", "text": "Texto completo inserido ao usar o atalho" } ] }
```

Cada entrada é um objeto com **`title`** (rótulo curto no menu) e **`text`** (conteúdo inserido). O servidor aceita legado (array de strings) e normaliza para esse formato. Máximo **50** itens.

---

## Permissões no painel web (papéis)

O backend **não aplica `requireAdmin`** nas rotas de relatório de vendas e perguntas ML listadas acima: qualquer usuário **autenticado** pode chamá-las se souber a URL.

No **frontend** atual:

| Recurso | Visibilidade no menu |
|---------|----------------------|
| Relatório (`/sales-report`) | `role >= 3` |
| Atendimento | `role >= 2` |

Replenishment (`/api/reports/replenishment`, etc.) é **admin (role 4)** no servidor e não faz parte deste escopo de “faturamento” tab Vendas.

---

## Erros comuns

| HTTP | Significado típico |
|------|---------------------|
| `401` | Sem token ou token ausente |
| `403` | Token inválido/expirado |
| `4xx/5xx` nas rotas ML | Corpo JSON com `message` / `error` do Mercado Livre |

---

## Versionamento deste documento

Gerado a partir do repositório Miti; ao alterar endpoints no `server/index.js` ou nos componentes citados, atualize este arquivo para manter o app Android alinhado.
