const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Configuração
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite');
const db = new sqlite3.Database(dbPath);

console.log('🔧 FORÇANDO MIGRAÇÃO: Coluna settings');
console.log('=====================================\n');

// Verificar se a coluna settings existe
db.all("PRAGMA table_info(users)", (err, columns) => {
  if (err) {
    console.error('❌ Erro ao verificar estrutura da tabela users:', err.message);
    db.close();
    return;
  }
  
  console.log('📊 Colunas atuais da tabela users:');
  columns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });
  
  const hasSettings = columns.some(col => col.name === 'settings');
  console.log(`\n🔍 Coluna 'settings' existe: ${hasSettings ? '✅ SIM' : '❌ NÃO'}`);
  
  if (hasSettings) {
    console.log('✅ Migração não necessária - coluna já existe');
    db.close();
    return;
  }
  
  // Forçar migração
  console.log('\n🔄 Executando migração...');
  db.run("ALTER TABLE users ADD COLUMN settings TEXT", function(err) {
    if (err) {
      console.error('❌ Erro ao adicionar coluna settings:', err.message);
      db.close();
      return;
    }
    
    console.log('✅ Coluna settings adicionada com sucesso!');
    console.log(`   Rows affected: ${this.changes}`);
    
    // Verificar novamente
    db.all("PRAGMA table_info(users)", (err2, columns2) => {
      if (err2) {
        console.error('❌ Erro ao verificar estrutura após migração:', err2.message);
        db.close();
        return;
      }
      
      console.log('\n📊 Colunas após migração:');
      columns2.forEach(col => {
        console.log(`   - ${col.name} (${col.type})`);
      });
      
      const hasSettingsAfter = columns2.some(col => col.name === 'settings');
      if (hasSettingsAfter) {
        console.log('\n🎉 MIGRAÇÃO CONCLUÍDA COM SUCESSO!');
        console.log('✅ A funcionalidade de fixar itens deve funcionar agora.');
        console.log('\n📋 Próximos passos:');
        console.log('1. Reinicie o servidor');
        console.log('2. Faça login novamente');
        console.log('3. Teste a funcionalidade de fixar itens');
      } else {
        console.log('\n❌ PROBLEMA: Coluna ainda não foi criada');
      }
      
      db.close();
    });
  });
}); 