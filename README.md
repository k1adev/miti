# Apoli - Sistema de Gestão v2.0

Uma aplicação web completa para hospedagem local com interface moderna, banco de dados SQLite, sistema de estoque avançado com SKUs compostos, integração com API do Bling e suporte a APIs externas.

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

## 🛠️ Instalação Rápida

### 1. Clone ou Baixe o Projeto

```bash
# Se você tem git instalado
git clone [URL_DO_REPOSITORIO]

# Ou baixe o arquivo ZIP e extraia
```

### 2. Instalação Automatizada

Execute o script de instalação:

```bash
# No Windows (PowerShell ou Prompt de Comando)
install.bat
```

O script irá:
- Verificar se o Node.js está instalado
- Instalar todas as dependências (backend e frontend)
- Criar arquivo de configuração padrão
- Criar pasta de uploads

### 3. Migração de Tokens (Se Aplicável)

Se você já tem tokens do Bling salvos em arquivo, execute a migração:

```bash
# Migrar tokens do arquivo para o banco de dados
node scripts/migrar_tokens_bling.js
```

### 4. Iniciar a Aplicação

```bash
# Opção 1: Script automatizado (recomendado)
start.bat

# Opção 2: Desenvolvimento
npm run dev

# Opção 3: Produção
npm start

# Opção 4: Aplicação desktop (Electron)
npm run electron
```

## 🌐 Acesso à Aplicação

- **Local**: http://localhost:3001
- **Rede Local**: http://[SEU_IP]:3001

Para encontrar seu IP na rede:
```bash
ipconfig
```

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

## 🔧 Scripts Disponíveis

### Scripts de Instalação e Configuração

```bash
# Instalação completa
install.bat              # Instala todas as dependências

# Inicialização
start.bat                # Inicia a aplicação com opções

# Atualização
update.bat               # Atualiza dependências e reconstrói

# Empacotamento
package.bat              # Cria executável para distribuição

# Limpeza
clean.bat                # Remove arquivos temporários
```

### Scripts NPM

```bash
# Desenvolvimento
npm run dev              # Inicia servidor com nodemon + React
npm start                # Inicia servidor de produção

# Frontend
cd client
npm start                # Servidor de desenvolvimento React
npm run build            # Build para produção

# Empacotamento
npm run electron         # Executa com Electron
npm run package          # Cria executável
npm run package-win      # Cria executável Windows
npm run clean            # Limpa arquivos temporários
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

## 🔄 Sistema de Atualizações

### Atualização Automatizada

```bash
# Executar script de atualização
update.bat
```

O script irá:
1. Fazer backup do banco de dados
2. Parar servidores em execução
3. Fazer backup das configurações
4. Atualizar dependências do backend
5. Atualizar dependências do frontend
6. Reconstruir a aplicação

### Backup Automático

Antes de cada atualização, o sistema cria:
- Backup do banco de dados com timestamp
- Backup do arquivo de configuração (.env)

## 🔗 Configuração da Integração Bling

### 1. Criar Aplicação no Bling

1. Acesse o [Portal de Desenvolvedores do Bling](https://www.bling.com.br/developers)
2. Crie uma nova aplicação
3. Configure as URLs de redirecionamento:
   - **Desenvolvimento**: `http://localhost:3001/api/bling/callback`
   - **Produção**: `https://seu-dominio.com/api/bling/callback`

### 2. Configurar Variáveis de Ambiente

Edite o arquivo `.env` e adicione:

```env
# Configurações do Bling API
BLING_CLIENT_ID=seu_client_id_aqui
BLING_CLIENT_SECRET=seu_client_secret_aqui
BLING_REDIRECT_URI=http://localhost:3001/api/bling/callback
```

### 3. Autenticação

1. Acesse a seção "APIs Externas" na aplicação
2. Clique em "Conectar Bling"
3. Autorize a aplicação no Bling
4. O token será salvo automaticamente no banco de dados

### 4. Migração de Tokens (Se Necessário)

Se você já tem tokens salvos em arquivo:

```bash
# Executar migração
node scripts/migrar_tokens_bling.js
```

### 5. Monitoramento

- **Status**: Verifique o status da conexão na interface
- **Logs**: Acesse os logs detalhados da API
- **Tokens**: Visualize e gerencie tokens armazenados

## 📦 Distribuição

### Criar Executável

```bash
# Empacotar para Windows
package.bat
```

O executável será criado na pasta `dist/` e incluirá:
- Aplicação completa
- Banco de dados SQLite
- Configurações padrão
- Instalador Windows

### Instalação em Outras Máquinas

1. Execute o instalador `.exe` na pasta `dist/`
2. Siga as instruções de instalação
3. A aplicação será instalada como programa desktop
4. Aparecerá no menu Iniciar e área de trabalho

## 🛡️ Segurança

- **CORS configurado** para acesso na rede local
- **Helmet** para proteção de headers HTTP
- **Validação de entrada** em todas as APIs
- **Sanitização de dados** para prevenir injeção SQL
- **Logs de segurança** para auditoria

## 🔧 Configuração

### Arquivo de Configuração (.env)

```bash
# Copiar arquivo de exemplo
copy env.example .env
```

Configurações disponíveis:
- `PORT`: Porta do servidor (padrão: 3001)
- `NODE_ENV`: Ambiente (development/production)
- `DB_PATH`: Caminho do banco de dados
- `SESSION_SECRET`: Chave secreta para sessões
- `CORS_ORIGIN`: Origem permitida para CORS
- `LOG_LEVEL`: Nível de log
- `MAX_FILE_SIZE`: Tamanho máximo de upload
- `API_TIMEOUT`: Timeout para APIs externas

## 🐛 Solução de Problemas

### Problemas Comuns

1. **Porta já em uso**
   ```bash
   # Parar processos Node.js
   taskkill /f /im node.exe
   ```

2. **Dependências corrompidas**
   ```bash
   # Limpar e reinstalar
   clean.bat
   install.bat
   ```

3. **Banco de dados corrompido**
   ```bash
   # Restaurar backup mais recente
   copy database_backup_*.sqlite database.sqlite
   ```

4. **Problemas de rede**
   - Verificar firewall do Windows
   - Verificar antivírus
   - Verificar configurações de rede

### Logs

Os logs são salvos em:
- Console do servidor
- Arquivos de log (se configurado)

## 📞 Suporte

Para suporte técnico:
1. Verifique a seção de solução de problemas
2. Consulte os logs do sistema
3. Execute `clean.bat` e `install.bat` para reinstalação limpa

## 📄 Licença

MIT License - veja o arquivo LICENSE para detalhes.

## 🔄 Changelog

### v2.0.0
- ✅ Scripts de instalação e atualização melhorados
- ✅ Sistema de backup automático
- ✅ Configuração de ambiente (.env)
- ✅ Empacotamento como aplicação desktop
- ✅ Correções de segurança
- ✅ Melhor tratamento de erros
- ✅ Interface mais robusta
- ✅ Sistema de limpeza de arquivos 