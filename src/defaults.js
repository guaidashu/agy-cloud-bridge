/**
 * 默认全局配置：
 * - 开箱支持直连本机 `agy` CLI，并可按需开启 `requireProxy=true` + 自定义代理启动器实现 Fail-Closed 出口隔离；
 * - 默认开启脏工作区安全阻断（`safe-block`）与全生命周期产物自动清理；
 * - 支持将 `runtime.runsDir` / `runtime.worktreesDir` 指向 `/tmp` 或内存盘（RAM Disk）进一步减少本机 SSD 擦写。
 */
export const DEFAULT_CONFIG = {
  version: 1,
  server: {
    host: "127.0.0.1",
    port: 3190,
    publicUrl: "",
    secretEnv: "AGY_BRIDGE_SECRET",
    replayWindowSec: 300,
  },
  agy: {
    // 可选：出口代理启动器脚本路径（参考 deploy/proxy/agy-proxy-launcher.sh.example）
    launcher: "",
    // 可选：设为 true 时强制经由 launcher 启动，脚本缺失或连通校验失败直接拒跑（Fail-Closed）
    requireProxy: false,
    binary: "",
    model: "",
    effort: "",
    mode: "",
    // 默认关闭 CLI 终端沙盒（避免 macOS Seatbelt 拦截 Cocos/Electron/WebGL GPU 截图与本地预览端口）；
    // 文件写范围与敏感路径保护由外部工作区 PreToolUse 护栏（agy-bridge-guard.mjs）统一执行，也可按需开启。
    sandbox: false,
    // 无头自动化协同默认免人工确认，安全由外部工作区 PreToolUse 护栏与路径白名单兜底
    dangerouslySkipPermissions: true,
    timeoutMs: 15 * 60 * 1000,
    env: {},
    extraArgs: [],
  },
  security: {
    deniedReadRoots: [
      "~/.agy-bridge",
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      "~/.kube",
      "~/.docker",
      "~/.codex",
      "~/.config/gh",
      "~/.gemini/antigravity-cli",
      "~/.gemini/config/config.json",
    ],
    // 可选：追加自定义凭据 .env 文件路径，网关会在回传日志与摘要前自动脱敏其中的密钥值
    extraRedactEnvFiles: [],
    skillsRoot: "~/.gemini/config/skills",
    allowedReadRoots: [],
    redact: true,
  },
  runtime: {
    home: "~/.agy-bridge",
    // 可选：将临时运行产物目录 / 临时 worktree 目录指向 /tmp 或内存盘，进一步降低本机 SSD 写入损耗
    runsDir: "",
    worktreesDir: "",
    concurrency: 2,
    defaultMaxRounds: 5,
    waitMaxSeconds: 300,
    maxHistoryRecords: 200,
  },
  cleanup: {
    purgeOnAck: true,
    retentionHours: 24,
    sweepIntervalMin: 30,
  },
  gitWatcher: {
    enabled: false,
    intervalSec: 20,
  },
  notify: {
    webhookUrl: "",
  },
  projects: [],
};
