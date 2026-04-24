# Miti - Sistema de Gestão v2.0

## 🚀 Características

- **Interface Web Moderna**: React + Tailwind CSS
- **Backend Robusto**: Node.js + Express
- **Banco de Dados Local**: SQLite (sem instalação adicional)
- **Sistema de Estoque Avançado**: Controle de inventário com SKU, EAN, localização
- **SKUs Compostos**: Criação e montagem de produtos compostos por outros SKUs
- **Integração Bling**: Conexão com API do Bling para extração de notas fiscais
- **Gestão de Pedidos**: Aglutinação e impressão de pedidos para expedição
- **Importação/Exportação**: Suporte a planilhas CSV
- **Acesso na Rede**: Configurado para acesso de outros computadores na rede
- **APIs Externas**: Suporte para conectar e testar APIs externas
- **Fácil Instalação**: Scripts automatizados para instalação
- **Empacotamento**: Suporte ao Electron para distribuição como aplicação desktop
- **Sistema de Atualizações**: Scripts automatizados para atualizações seguras

## 📋 Pré-requisitos

- **Node.js** (versão 16 ou superior)
- **npm** (vem com o Node.js)
- **Windows 10/11** (testado)


## 📁 Estrutura do Projeto

```
apoli/
├── server/                 # Backend (Node.js + Express)
│   └── index.js           # Servidor principal
├── client/                # Frontend (React)
│   ├── src/
│   │   ├── components/    # Componentes React
│   │   ├── App.js         # Componente principal
│   │   └── index.js       # Ponto de entrada
│   └── public/            # Arquivos públicos
├── package.json           # Dependências do backend
├── main.js               # Configuração do Electron
├── install.bat           # Script de instalação
├── start.bat             # Script de inicialização
├── update.bat            # Script de atualização
├── package.bat           # Script de empacotamento
├── clean.bat             # Script de limpeza
├── env.example           # Exemplo de configuração
└── README.md             # Este arquivo
```

## 📊 Funcionalidades

### Dashboard
- Visão geral do sistema
- Estatísticas em tempo real
- Status do servidor e banco de dados

### Usuários
- Cadastro de usuários
- Listagem com busca
- Edição e exclusão

### Estoque
- **Controle Completo de Inventário**:
  - SKU (código único do produto)
  - EAN (código de barras)
  - Título do produto
  - Quantidade em estoque
  - Localização física
  - Quantidade mínima e máxima
  - Categoria e fornecedor
  - Preços de custo e venda
  - Observações

- **SKUs Compostos**:
  - Criação de produtos compostos por outros SKUs
  - Definição de componentes e quantidades
  - Montagem automática consumindo componentes
  - Cálculo de capacidade de montagem
  - Histórico de movimentações

- **Funcionalidades Avançadas**:
  - Busca por SKU, EAN ou título
  - Filtros por categoria
  - Alertas de estoque baixo
  - Estatísticas em tempo real
  - Histórico de movimentações

- **Importação/Exportação**:
  - Exportação para CSV
  - Importação de planilhas CSV
  - Upload de arquivos
  - Validação de dados
  - Relatório de erros

### Pedidos (Integração Bling)
- **Extração de Notas Fiscais**: Conexão com API do Bling
- **Gestão de Pedidos**: Visualização e seleção de notas fiscais
- **Aglutinação Inteligente**: Agrupamento de itens por SKU
- **Identificação de Marketplaces**: Classificação automática de origens
- **Impressão de Relatórios**: Geração de relatórios para expedição
- **Autorização OAuth**: Fluxo seguro de autenticação com Bling

### Vendas
- Registro de vendas
- Integração com estoque
- Histórico de transações

### APIs Externas
- Configuração de APIs
- Teste de conectividade
- Gerenciamento de chaves

### Integração Bling
- **Autenticação OAuth 2.0**: Fluxo seguro de autorização
- **Persistência de Tokens**: Armazenamento no banco de dados SQLite
- **Renovação Automática**: Refresh tokens automáticos
- **Migração de Tokens**: Script para migrar tokens de arquivo para banco
- **Monitoramento**: Logs detalhados e status de conectividade
- **Gestão de Tokens**: Interface para visualizar e limpar tokens antigos

### Status do Sistema
- Monitoramento em tempo real
- Logs do sistema
- Informações de conectividade

### Sincronização automática de pedidos

O sistema tem quatro crons independentes, configuráveis por env (em minutos, `0` desliga):

| Variável | Default | O que faz |
|----------|---------|-----------|
| `ORDERS_AUTO_INTERVAL_MIN` | `5` | Sync leve de **pedidos** ML+Shopee em modo delta (só novos/atualizados desde o último sync) + recálculo de custos em background. Sempre on para toda conta com token válido. |
| `NFE_AUTO_INTERVAL_MIN` | `10` | Leitura de **NFes** (Faturador ML + Bling + upload na Shopee). Não emite, só lê. |
| `AUTO_SYNC_INTERVAL_MIN` | `0` | Sync de **catálogo** (itens/anúncios). Opt-in por conta via `auto_sync_enabled`. |
| `MARKETPLACE_AUTO_INTERVAL_MIN` | `0` | **Emissão** completa de NF Shopee (envia pro Bling e faz upload). Opt-in por conta via `auto_invoice_enabled`. |

Na tela **Pedidos Marketplace** existe também um seletor de auto-refresh (`Off / 1 / 5 / 15 min`) que chama `POST /api/marketplace-orders/sync-delta` e relê a lista sem precisar clicar em "Buscar Pedidos". A preferência fica salva no navegador.

### Webhook do Mercado Livre (quase tempo real)

A rota `POST /api/ml/callback` aceita notificações do Mercado Livre e usa-as para sincronizar um pedido específico na hora (sem esperar o próximo ciclo do cron delta). Os topics roteados são:

- `orders_v2` / `orders` → busca `/orders/{id}` e aplica INSERT/UPDATE + recálculo de custos.
- `shipments` → resolve `order_id` a partir do shipment e sincroniza o pedido correspondente (útil para atualizações de etiqueta / status de envio).

Topics diferentes são ignorados no webhook e continuam sendo tratados por outros fluxos (ex.: `questions` pela aba de Atendimento, `items` pelo sync de catálogo). A notificação é respondida com `200 OK` imediatamente e o processamento é feito em background; duplicatas do mesmo pedido são coalesce-adas enquanto a sync está em andamento.

Para ligar/desligar o webhook sem mexer na assinatura no painel do ML, use `ML_WEBHOOK_ENABLED=0` / `1`. A autenticidade é validada cruzando `user_id` com os `ml_accounts` conectados — notificações de outros sellers são ignoradas.

### Stream de eventos em tempo real (SSE)

`GET /api/events/stream` é um canal SSE que empurra eventos do servidor para qualquer cliente conectado. A tela **Pedidos Marketplace** assina esse canal automaticamente enquanto está aberta e, ao receber `order_synced` (emitido sempre que um pedido é atualizado no DB — via webhook ML, cron delta ou sync manual), relê a lista imediatamente. Os ciclos de polling do cliente (Auto 1/5/15 min) continuam ativos como fallback caso o stream caia.

Eventos atuais:
- `hello`: handshake inicial após conexão.
- `order_synced`: pedido foi atualizado. Payload: `{ marketplace, marketplaceOrderId, accountId, localId, source, isNew }`. Só é emitido em mudança real (snapshot_hash diferente) para não spammar o canal.

A autenticação usa o mesmo JWT do app, passado via query string (`?token=...`) já que `EventSource` não permite custom headers.

## 📦 Sistema de Estoque

### Estrutura dos Dados
Cada item do estoque contém:
- **SKU**: Código único identificador (obrigatório)
- **EAN**: Código de barras (opcional)
- **Título**: Nome do produto (obrigatório)
- **Quantidade**: Quantidade atual em estoque
- **Localização**: Posição física no estoque
- **Quantidade Mínima**: Alerta quando estoque está baixo
- **Quantidade Máxima**: Capacidade máxima
- **Categoria**: Classificação do produto
- **Fornecedor**: Fornecedor do produto
- **Preço de Custo**: Custo de aquisição
- **Preço de Venda**: Preço de venda
- **Observações**: Notas adicionais
- **SKU Composto**: Indica se é um produto montado a partir de outros

### SKUs Compostos
Um SKU composto é um produto que é montado a partir de outros SKUs do estoque:

**Exemplo:**
- SKU Principal: `1234` (Kit Completo)
- Componentes:
  - 1 unidade do SKU `1111` (Base)
  - 4 unidades do SKU `2222` (Parafusos)

**Funcionalidades:**
1. **Criação**: Marque um item como "SKU Composto" no formulário
2. **Configuração**: Use o botão "Gerenciar Componentes" para definir os SKUs e quantidades
3. **Montagem**: Use o botão "Montar SKU" para criar o produto consumindo os componentes
4. **Controle**: O sistema calcula automaticamente quantas unidades podem ser montadas

**Vantagens:**
- Controle preciso de componentes
- Montagem automática
- Histórico de movimentações
- Cálculo de capacidade


### 5. Monitoramento

- **Status**: Verifique o status da conexão na interface
- **Logs**: Acesse os logs detalhados da API
- **Tokens**: Visualize e gerencie tokens armazenados


## 🛡️ Segurança

- **CORS configurado** para acesso na rede local
- **Helmet** para proteção de headers HTTP
- **Validação de entrada** em todas as APIs
- **Sanitização de dados** para prevenir injeção SQL
- **Logs de segurança** para auditoria



### v2.0.0
- ✅ Scripts de instalação e atualização melhorados
- ✅ Sistema de backup automático
- ✅ Configuração de ambiente (.env)
- ✅ Empacotamento como aplicação desktop
- ✅ Correções de segurança
- ✅ Melhor tratamento de erros
- ✅ Interface mais robusta
- ✅ Sistema de limpeza de arquivos 
