module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "server.js",
      cwd: "D:\\mcp-server",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      // Windows-friendly: PM2 puts logs under %USERPROFILE%\.pm2\logs
      out_file: "C:\\Users\\Admin\\.pm2\\logs\\mcp-server-out.log",
      error_file: "C:\\Users\\Admin\\.pm2\\logs\\mcp-server-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
