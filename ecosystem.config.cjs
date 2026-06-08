module.exports = {
  apps: [
    {
      name: 'fcc-gateway',
      script: 'dist/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 5000,
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
        // PM2_APP_NAME must match the `name` field above so the admin
        // "Restart Gateway" button can trigger `pm2 restart fcc-gateway`
        PM2_APP_NAME: 'fcc-gateway',
      },
    },
  ],
};
