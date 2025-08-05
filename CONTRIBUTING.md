# Contribuindo para o Apoli

Obrigado por considerar contribuir para o projeto Apoli! Este documento fornece diretrizes para contribuições.

## 🚀 Como Contribuir

### 1. Fork e Clone

1. Faça um fork do repositório
2. Clone seu fork localmente:
   ```bash
   git clone https://github.com/seu-usuario/apoli.git
   cd apoli
   ```

### 2. Configuração do Ambiente

1. Instale as dependências:
   ```bash
   npm run install-all
   ```

2. Configure as variáveis de ambiente:
   ```bash
   cp env.example .env
   # Edite o arquivo .env com suas configurações
   ```

3. Inicie o servidor de desenvolvimento:
   ```bash
   npm run dev
   ```

### 3. Estrutura do Projeto

- `server/` - Backend Node.js/Express
- `client/` - Frontend React
- `server/index.js` - Servidor principal
- `client/src/components/` - Componentes React

### 4. Padrões de Código

#### Backend (Node.js)
- Use ES6+ features
- Siga o padrão camelCase para variáveis
- Use async/await para operações assíncronas
- Documente funções complexas com JSDoc

#### Frontend (React)
- Use componentes funcionais com hooks
- Siga o padrão PascalCase para componentes
- Use Tailwind CSS para estilização
- Mantenha componentes pequenos e focados

### 5. Commits

Use mensagens de commit descritivas:
```bash
git commit -m "feat: adiciona funcionalidade de SKUs compostos"
git commit -m "fix: corrige bug na autenticação"
git commit -m "docs: atualiza README"
```

### 6. Pull Request

1. Crie uma branch para sua feature:
   ```bash
   git checkout -b feature/nova-funcionalidade
   ```

2. Faça suas alterações e commits

3. Envie para seu fork:
   ```bash
   git push origin feature/nova-funcionalidade
   ```

4. Abra um Pull Request no repositório original

### 7. Checklist do PR

- [ ] Código segue os padrões do projeto
- [ ] Testes passam (se aplicável)
- [ ] Documentação foi atualizada
- [ ] Não há conflitos de merge
- [ ] Descrição clara das mudanças

## 🐛 Reportando Bugs

Use o template de issue para bugs:
- Descrição detalhada do problema
- Passos para reproduzir
- Comportamento esperado vs atual
- Screenshots (se aplicável)
- Informações do ambiente

## 💡 Sugerindo Features

Use o template de issue para features:
- Descrição da funcionalidade
- Caso de uso
- Benefícios
- Mockups (se aplicável)

## 📝 Documentação

- Mantenha o README atualizado
- Documente APIs novas
- Adicione comentários em código complexo
- Atualize o CHANGELOG para mudanças significativas

## 🔧 Desenvolvimento

### Scripts Úteis

```bash
# Desenvolvimento
npm run dev              # Servidor + React
npm start                # Produção

# Frontend
cd client
npm start                # React dev server
npm run build            # Build para produção

# Empacotamento
npm run electron         # Executar com Electron
npm run package-win      # Criar executável Windows
```

### Estrutura do Banco de Dados

O sistema usa SQLite com as seguintes tabelas principais:
- `users` - Usuários e permissões
- `inventory` - Produtos do estoque
- `inventory_movements` - Movimentações
- `composite_skus` - SKUs compostos
- `api_tokens` - Tokens de APIs externas

## 📞 Suporte

Para dúvidas sobre contribuição:
- Abra uma issue
- Consulte a documentação
- Verifique issues existentes

Obrigado por contribuir! 🎉 