module.exports = {
  apps: [{
    name:         'olka-studio',
    script:       'server.js',
    instances:    1,
    autorestart:  true,
    watch:        false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT:     3000
    },
    env_file:     '.env',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file:     './logs/out.log',
    error_file:   './logs/error.log',
    merge_logs:   true,
    restart_delay: 3000
  }]
};
