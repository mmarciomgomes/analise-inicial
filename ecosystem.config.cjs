// pm2: sobe os dois processos da Análise com um comando  →  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    { name: 'analise-api', script: 'server.js', max_memory_restart: '500M', time: true },
    { name: 'analise', script: 'worker/analise.mjs', max_memory_restart: '700M', time: true },
  ],
};
