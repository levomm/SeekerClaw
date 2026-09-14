const fs = require('fs');

const aiPath = 'app/src/main/assets/nodejs-project/ai.js';
const systemToolsPath = 'app/src/main/assets/nodejs-project/tools/system.js';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`[hardening] ${label}: target not found`);
  const second = source.indexOf(before, first + before.length);
  if (second >= 0) throw new Error(`[hardening] ${label}: target is not unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let ai = fs.readFileSync(aiPath, 'utf8');

ai = replaceOnce(
  ai,
  `function classifyApiError(status, data) {\n    return getAdapter(PROVIDER).classifyError(status, data);\n}`,
  `function classifyApiError(status, data) {\n    // Context Lite hardening: OpenAI currently returns cyber-policy blocks as\n    // HTTP 500 + { type: \"invalid_request\", code: \"cyber_policy\" }.\n    // The status code alone therefore looks retryable even though the body says\n    // the request is terminal. Never spin the retry loop for this condition.\n    const errorCode = data && typeof data === 'object'\n        ? ((data.error && typeof data.error === 'object' && data.error.code) || data.code || null)\n        : null;\n    if (errorCode === 'cyber_policy') {\n        return {\n            type: 'policy',\n            retryable: false,\n            userMessage: 'OpenAI blocked this request under cyber policy. This task was stopped and will not retry automatically.'\n        };\n    }\n    return getAdapter(PROVIDER).classifyError(status, data);\n}`,
  'cyber_policy classification'
);

ai = replaceOnce(
  ai,
  `const AGING_RECENCY_THRESHOLD = 6;  // messages within this distance from end are \"recent\"\nconst AGING_SIZE_THRESHOLD = 800;   // chars — only age results larger than this`,
  `const AGING_RECENCY_THRESHOLD = 4;  // Context Lite: keep only the freshest tool-result tail verbatim\nconst AGING_SIZE_THRESHOLD = 600;   // Context Lite: compact medium/large stale tool results earlier`,
  'tool-result aging thresholds'
);

ai = replaceOnce(
  ai,
  `_trimHistoryLogged(messages, MAX_HISTORY, _turnAnchor, turnId, 'toolRound');`,
  `// Context Lite: long tool loops otherwise keep ~35 messages and can grow past\n            // 200 KB even with deferred tool schemas. After eight tool rounds, keep a\n            // tighter recent window while anchor-preserving/group-atomic trimming\n            // continues to protect the original user instruction.\n            const toolRoundHistoryCap = stepCount >= 8 ? 22 : MAX_HISTORY;\n            _trimHistoryLogged(messages, toolRoundHistoryCap, _turnAnchor, turnId, 'toolRound');`,
  'long-turn history cap'
);

ai = replaceOnce(
  ai,
  `                const httpErr = new Error(userText);\n                httpErr._sanitized = true;\n                throw httpErr;`,
  `                // A provider policy block is terminal for this task. Delete its\n                // durable checkpoint before throwing so a service restart cannot\n                // resurrect the same blocked request through AutoResume.\n                if (errCode === 'cyber_policy') {\n                    clearActiveTask(chatId);\n                    try {\n                        cleanupChatCheckpoints(chatId);\n                        log(\`[Policy] turnId=\${turnId} code=cyber_policy terminal=true checkpoint=cleared\`, 'WARN');\n                    } catch (cleanupErr) {\n                        log(\`[Policy] checkpoint cleanup failed: \${cleanupErr && cleanupErr.message ? cleanupErr.message : String(cleanupErr)}\`, 'WARN');\n                    }\n                }\n                const httpErr = new Error(userText);\n                httpErr._sanitized = true;\n                httpErr._terminalTask = errCode === 'cyber_policy';\n                throw httpErr;`,
  'terminal policy checkpoint cleanup'
);

fs.writeFileSync(aiPath, ai);

let sys = fs.readFileSync(systemToolsPath, 'utf8');

sys = replaceOnce(
  sys,
  `                            const filePath = String(args[0]);\n                            // Resolve symlinks to prevent alias bypass (symlink -> config.json)\n                            let resolvedPath = filePath;\n                            try { resolvedPath = fs.realpathSync(filePath); } catch (_) {}\n                            const basename = path.basename(resolvedPath);`,
  `                            const filePath = String(args[0]);\n                            // js_eval runs in a VM, but host fs resolves relative paths\n                            // against Node's real process cwd (the engine source dir), not\n                            // safeProcess.cwd(). Normalize every guarded fs path to the\n                            // workspace so js_eval and shell_exec agree on reports/evidence.\n                            let resolvedPath = path.isAbsolute(filePath)\n                                ? path.resolve(filePath)\n                                : path.resolve(workDir, filePath);\n                            const resolvedWorkspace = path.resolve(workDir);\n                            const inWorkspace = resolvedPath === resolvedWorkspace\n                                || resolvedPath.startsWith(resolvedWorkspace + path.sep);\n                            if (!inWorkspace) {\n                                throw new Error('js_eval fs access outside workspace is blocked.');\n                            }\n                            args[0] = resolvedPath;\n                            // Resolve symlinks where the target already exists for the\n                            // sensitive-basename check below.\n                            try { resolvedPath = fs.realpathSync(resolvedPath); } catch (_) {}\n                            const basename = path.basename(resolvedPath);`,
  'js_eval workspace path normalization'
);

sys = replaceOnce(
  sys,
  `        const FS_GUARDED = new Set([\n            'readFileSync', 'readFile', 'createReadStream', 'openSync', 'open',\n            'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',\n            'copyFileSync', 'copyFile', 'cpSync', 'cp',\n            'symlinkSync', 'symlink', 'linkSync', 'link',\n        ]);\n        const FSP_GUARDED = new Set(['readFile', 'writeFile', 'appendFile', 'open', 'copyFile', 'cp']);`,
  `        const FS_GUARDED = new Set([\n            'readFileSync', 'readFile', 'createReadStream', 'openSync', 'open',\n            'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',\n            'mkdirSync', 'mkdir', 'readdirSync', 'readdir', 'statSync', 'stat', 'lstatSync', 'lstat',\n            'accessSync', 'access', 'existsSync', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir',\n            'copyFileSync', 'copyFile', 'cpSync', 'cp',\n            'symlinkSync', 'symlink', 'linkSync', 'link',\n        ]);\n        const FSP_GUARDED = new Set([\n            'readFile', 'writeFile', 'appendFile', 'open',\n            'mkdir', 'readdir', 'stat', 'lstat', 'access', 'unlink', 'rm', 'rmdir',\n            'copyFile', 'cp'\n        ]);`,
  'js_eval guarded workspace fs methods'
);

fs.writeFileSync(systemToolsPath, sys);

console.log('[hardening] applied: cyber_policy terminal handling');
console.log('[hardening] applied: long-turn context compaction');
console.log('[hardening] applied: js_eval workspace-relative fs paths');
