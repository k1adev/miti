const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(path.join(__dirname, '..', 'database.sqlite'));

db.serialize(() => {
  db.get("PRAGMA table_info(users)", (err, row) => {
    if (err) throw err;
  });

  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) throw err;
    const colNames = columns.map(c => c.name);
    if (!colNames.includes('password')) {
      db.run('ALTER TABLE users ADD COLUMN password TEXT');
      console.log('Coluna password adicionada!');
    }
    if (!colNames.includes('role')) {
      db.run('ALTER TABLE users ADD COLUMN role INTEGER DEFAULT 1');
      console.log('Coluna role adicionada!');
    }
    console.log('Migração concluída!');
    db.close();
  });
}); 