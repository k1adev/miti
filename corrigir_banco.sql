-- Script para corrigir settings corrompidos no banco de dados
-- Execute este script diretamente no banco SQLite

-- 1. Limpar todos os settings corrompidos
UPDATE users SET settings = '{"pinnedSkus":[]}' WHERE settings IS NULL;

-- 2. Corrigir settings que contêm HTML
UPDATE users SET settings = '{"pinnedSkus":[]}' 
WHERE settings LIKE '%<!doctype html>%' 
   OR settings LIKE '%<html%' 
   OR settings LIKE '%<head>%';

-- 3. Corrigir settings JSON inválidos
UPDATE users SET settings = '{"pinnedSkus":[]}' 
WHERE settings NOT LIKE '%pinnedSkus%' 
   OR settings NOT LIKE '%{%' 
   OR settings NOT LIKE '%}%';

-- 4. Verificar se há algum setting válido que precisa ser preservado
-- (manter apenas os que têm pinnedSkus válidos)
UPDATE users SET settings = '{"pinnedSkus":[]}' 
WHERE settings NOT LIKE '%"pinnedSkus"%';

-- 5. Verificar o resultado
SELECT id, name, email, settings FROM users; 