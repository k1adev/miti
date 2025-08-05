# Miti - Sistema de Gestão Empresarial

Uma aplicação web completa para gestão empresarial com interface moderna, banco de dados SQLite, sistema de estoque avançado com SKUs compostos, integração com API do Bling e suporte a APIs externas.

## 🚀 Demo Online

**Acesse a demonstração:** [Demo Miti](https://miti-demo.vercel.app)

> ⚠️ **Nota:** Este é um repositório privado para proteção intelectual. Para acesso ao código fonte ou colaboração, entre em contato.

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
- **Sistema de Permissões**: 4 níveis de acesso com controle granular
- **Empacotamento**: Suporte ao Electron para distribuição como aplicação desktop

## 🛠️ Tecnologias Utilizadas

### Backend
- **Node.js** - Runtime JavaScript
- **Express.js** - Framework web
- **SQLite3** - Banco de dados local
- **JWT** - Autenticação e autorização
- **bcryptjs** - Criptografia de senhas
- **Helmet** - Segurança HTTP
- **CORS** - Cross-origin resource sharing
- **Multer** - Upload de arquivos
- **Axios** - Cliente HTTP

### Frontend
- **React 18** - Biblioteca JavaScript para interfaces
- **React Router** - Roteamento
- **Tailwind CSS** - Framework CSS utilitário
- **Lucide React** - Ícones
- **Axios** - Cliente HTTP

### Empacotamento
- **Electron** - Framework para aplicações desktop
- **Electron Builder** - Empacotamento de aplicações

## 📁 Estrutura do Projeto

```
apoli/
├── server/                 # Backend (Node.js + Express)
│   ├── index.js           # Servidor principal
│   ├── config.js          # Configurações
│   └── bling_token.json   # Tokens do Bling (se existir)
├── client/                # Frontend (React)
│   ├── src/
│   │   ├── components/    # Componentes React
│   │   │   ├── Inventory.js           # Gestão de estoque
│   │   │   ├── CompositeSkuManager.js # SKUs compostos
│   │   │   ├── ExternalAPIs.js        # APIs externas
│   │   │   ├── Sales.js               # Vendas
│   │   │   ├── Users.js               # Gestão de usuários
│   │   │   ├── Sidebar.js             # Navegação
│   │   │   └── Login.js               # Autenticação
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

## 🔧 Scripts Disponíveis

```bash
# Instalação
npm run install-all        # Instala todas as dependências

# Desenvolvimento
npm run dev                # Inicia servidor com nodemon + React
npm start                  # Inicia servidor de produção

# Frontend
cd client
npm start                  # Servidor de desenvolvimento React
npm run build              # Build para produção

# Empacotamento
npm run electron           # Executa com Electron
npm run package            # Cria executável
npm run package-win        # Cria executável Windows
npm run clean              # Limpa arquivos temporários
```

## 📊 Funcionalidades Principais

### Dashboard
- Visão geral do sistema
- Estatísticas em tempo real
- Status do servidor e banco de dados

### Sistema de Usuários
- **4 Níveis de Acesso:**
  - Nível 1: Apenas estoque
  - Nível 2: + Vendas
  - Nível 3: + APIs Externas
  - Nível 4: + Usuários e Status (Admin)
- Cadastro, edição e exclusão de usuários
- Controle de permissões granular

### Gestão de Estoque
- **Controle Completo de Inventário:**
  - SKU (código único do produto)
  - EAN (código de barras)
  - Título do produto
  - Quantidade em estoque
  - Localização física
  - Quantidade mínima e máxima
  - Categoria e fornecedor
  - Preços de custo e venda
  - Observações

- **SKUs Compostos (Funcionalidade Única):**
  - Criação de produtos compostos por outros SKUs
  - Definição de componentes e quantidades
  - Montagem automática consumindo componentes
  - Cálculo de capacidade de montagem
  - Histórico de movimentações

- **Funcionalidades Avançadas:**
  - Busca por SKU, EAN ou título
  - Filtros por categoria
  - Alertas de estoque baixo
  - Estatísticas em tempo real
  - Histórico de movimentações
  - SKUs fixados para acesso rápido

- **Importação/Exportação:**
  - Exportação para CSV
  - Importação de planilhas CSV
  - Upload de arquivos
  - Validação de dados
  - Relatório de erros

### Integração Bling
- **Autenticação OAuth 2.0**: Fluxo seguro de autorização
- **Extração de Notas Fiscais**: Conexão com API do Bling
- **Gestão de Pedidos**: Visualização e seleção de notas fiscais
- **Aglutinação Inteligente**: Agrupamento de itens por SKU
- **Identificação de Marketplaces**: Classificação automática de origens
- **Impressão de Relatórios**: Geração de relatórios para expedição
- **Persistência de Tokens**: Armazenamento no banco de dados SQLite
- **Renovação Automática**: Refresh tokens automáticos

### Sistema de Vendas
- Registro de vendas
- Integração com estoque
- Histórico de transações

### APIs Externas
- Configuração de APIs
- Teste de conectividade
- Gerenciamento de chaves

### Status do Sistema
- Monitoramento em tempo real
- Logs do sistema
- Informações de conectividade

## 🎯 Destaques Técnicos

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

### Integração Bling
- **OAuth 2.0**: Autenticação segura com tokens
- **API REST**: Comunicação com endpoints do Bling
- **Cache Inteligente**: Cache de notas fiscais para performance
- **Tratamento de Erros**: Retry automático e fallbacks
- **Logs Detalhados**: Monitoramento completo da integração

## 🛡️ Segurança

- **CORS configurado** para acesso na rede local
- **Helmet** para proteção de headers HTTP
- **Validação de entrada** em todas as APIs
- **Sanitização de dados** para prevenir injeção SQL
- **JWT** para autenticação segura
- **bcryptjs** para criptografia de senhas
- **Logs de segurança** para auditoria



Configurações disponíveis:
- `PORT`: Porta do servidor (padrão: 3001)
- `NODE_ENV`: Ambiente (development/production)
- `DB_PATH`: Caminho do banco de dados
- `JWT_SECRET`: Chave secreta para JWT
- `CORS_ORIGIN`: Origem permitida para CORS
- `BLING_CLIENT_ID`: ID do cliente Bling
- `BLING_CLIENT_SECRET`: Secret do cliente Bling
- `BLING_REDIRECT_URI`: URI de redirecionamento Bling

## 📄 Licença

MIT License - veja o arquivo LICENSE para detalhes.

## 🔄 Changelog

### v2.0.0
- ✅ Sistema de SKUs compostos implementado
- ✅ Integração completa com Bling API
- ✅ Interface moderna com Tailwind CSS
- ✅ Sistema de permissões granular
- ✅ Scripts de automação
- ✅ Empacotamento com Electron
- ✅ Correções de segurança
- ✅ Melhor tratamento de erros 