const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// Configuração para Fly.io
const dbPath = process.env.DB_PATH || '/data/database.sqlite';

console.log('🔧 CORREÇÃO RÁPIDA: Settings Corrompidos');
console.log('========================================\n');

console.log('📊 Informações:');
console.log(`   DB_PATH: ${dbPath}`);
console.log(`   Existe: ${fs.existsSync(dbPath)}`);
console.log('');

if (!fs.existsSync(dbPath)) {
  console.error('❌ Banco de dados não encontrado!');
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);

// Executar correções
console.log('🔧 Executando correções...\n');

const queries = [
  "UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings IS NULL",
  "UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings LIKE '%<!doctype html>%' OR settings LIKE '%<html%' OR settings LIKE '%<head>%'",
  "UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings NOT LIKE '%pinnedSkus%' OR settings NOT LIKE '%{%' OR settings NOT LIKE '%}%'",
  "UPDATE users SET settings = '{\"pinnedSkus\":[]}' WHERE settings NOT LIKE '%\"pinnedSkus\"%'"
];

let completed = 0;

queries.forEach((query, index) => {
  console.log(`Executando correção ${index + 1}/4...`);
  
  db.run(query, function(err) {
    if (err) {
      console.error(`❌ Erro na correção ${index + 1}:`, err.message);
    } else {
      console.log(`✅ Correção ${index + 1} executada. Linhas afetadas: ${this.changes}`);
    }
    
    completed++;
    
    if (completed === queries.length) {
      // Verificar resultado
      console.log('\n📊 Verificando resultado...\n');
      
      db.all('SELECT id, name, email, settings FROM users', (err, users) => {
        if (err) {
          console.error('❌ Erro ao verificar:', err.message);
        } else {
          console.log('✅ Usuários após correção:');
          users.forEach(user => {
            console.log(`   ${user.name} (${user.email}): ${user.settings}`);
          });
        }
        
        console.log('\n🎉 CORREÇÃO CONCLUÍDA!');
        console.log('📋 Próximos passos:');
        console.log('1. Reinicie a aplicação');
        console.log('2. Faça login novamente');
        console.log('3. Teste a funcionalidade de fixar itens');
        
        db.close();
      });
    }
  });
}); 