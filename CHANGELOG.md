# Changelog - Apoli Sistema de Gestão

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

## [2.0.0] - 2024-01-XX

### ✨ Adicionado
- **Sistema de scripts automatizados**:
  - `install.bat` - Instalação completa e robusta
  - `start.bat` - Inicialização inteligente com opções
  - `update.bat` - Atualização segura com backup automático
  - `package.bat` - Empacotamento para distribuição
  - `clean.bat` - Limpeza de arquivos temporários
  - `health-check.bat` - Verificação de saúde do sistema

- **Sistema de configuração**:
  - Arquivo `env.example` com configurações padrão
  - Sistema de configuração centralizado (`server/config.js`)
  - Validação automática de configurações
  - Suporte a variáveis de ambiente

- **Melhorias no Electron**:
  - Configuração corrigida para porta 3001
  - Menu melhorado com mais opções
  - Prevenção de múltiplas instâncias
  - Navegação segura
  - Interface mais robusta

- **Sistema de backup**:
  - Backup automático antes de atualizações
  - Backup do banco de dados com timestamp
  - Backup de configurações
  - Sistema de recuperação

- **Documentação melhorada**:
  - README.md completo e atualizado
  - Instruções detalhadas para SKUs compostos
  - Guia de instalação rápida
  - Changelog detalhado

### 🔧 Melhorado
- **Package.json**:
  - Scripts mais robustos e organizados
  - Dependências atualizadas
  - Configuração de build melhorada
  - Suporte a diferentes ambientes

- **Segurança**:
  - Configuração de CORS melhorada
  - Headers de segurança (Helmet)
  - Validação de entrada mais rigorosa
  - Sanitização de dados

- **Performance**:
  - Build otimizado para produção
  - Configuração de cache melhorada
  - Compressão de arquivos estáticos

- **Usabilidade**:
  - Scripts mais informativos
  - Melhor tratamento de erros
  - Feedback visual durante operações
  - Instruções claras

### 🐛 Corrigido
- **Configuração do Electron**: Corrigida porta de desenvolvimento (3000 → 3001)
- **Scripts de instalação**: Verificações mais robustas
- **Dependências**: Versões compatíveis e atualizadas
- **Configuração de build**: Inclusão de todos os arquivos necessários
- **Tratamento de erros**: Melhor feedback para problemas comuns

### 🔄 Mudanças Breaking
- **Porta padrão**: Mudança de 3000 para 3001 (backend)
- **Estrutura de configuração**: Novo sistema baseado em arquivo .env
- **Scripts**: Novos nomes e funcionalidades

### 📦 Distribuição
- **Empacotamento**: Suporte completo ao Electron Builder
- **Instalador Windows**: Configuração NSIS
- **Recursos**: Inclusão de todos os arquivos necessários
- **Atalhos**: Criação automática de atalhos

## [1.0.0] - 2023-XX-XX

### ✨ Adicionado
- Sistema de gestão de estoque completo
- Controle de SKUs compostos
- Sistema de vendas
- Gestão de usuários
- APIs externas
- Interface web moderna (React + Tailwind)
- Backend robusto (Node.js + Express)
- Banco de dados SQLite
- Sistema de importação/exportação CSV
- Acesso na rede local

### 🔧 Funcionalidades
- Dashboard com estatísticas
- Controle de inventário avançado
- Montagem automática de produtos compostos
- Histórico de movimentações
- Alertas de estoque baixo
- Busca e filtros
- Relatórios básicos

---

## Como Usar Este Changelog

### Formato
- **Adicionado**: Novas funcionalidades
- **Melhorado**: Mudanças em funcionalidades existentes
- **Corrigido**: Correções de bugs
- **Mudanças Breaking**: Mudanças que quebram compatibilidade
- **Removido**: Funcionalidades removidas

### Versionamento
- **MAJOR.MINOR.PATCH**
- MAJOR: Mudanças breaking
- MINOR: Novas funcionalidades
- PATCH: Correções de bugs

---

**Nota**: Este changelog segue o padrão [Keep a Changelog](https://keepachangelog.com/). 