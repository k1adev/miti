const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const db = new sqlite3.Database(path.join(__dirname, '..', 'database.sqlite'));

const email = 'admin@apoli.com';
const novaSenha = 'admin123';
const hash = bcrypt.hashSync(novaSenha, 10);

db.run('UPDATE users SET password = ?, role = 4 WHERE email = ?', [hash, email], function(err) {
  if (err) {
    console.error('Erro ao atualizar senha do admin:', err);
  } else {
    console.log('Senha do admin atualizada com sucesso!');
  }
  db.close();
}); 