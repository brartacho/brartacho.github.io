// pm2 ecosystem — radar-mcp daemon
// Precisa ser .cjs porque o projeto é ESM ("type":"module" no package.json)
// e pm2 lê o ecosystem via require() interno.
module.exports = {
    apps: [{
        name: 'radar-mcp',
        script: 'mcp/radar-server.js',
        cwd: __dirname,
        watch: false,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 5000,
        exp_backoff_restart_delay: 100,
        kill_timeout: 35000,
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: 'logs/radar-mcp-error.log',
        out_file: 'logs/radar-mcp.log',
        merge_logs: true,
    }],
};
