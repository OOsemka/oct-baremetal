import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function sendLog(level: LogLevel, action: string, message: string, details?: string) {
  const payload: Record<string, string> = { level, action, message };
  if (details) {
    payload.details = details;
  }

  // Path segment `oct-baremetal` is consolePlugin.name — do not rename.
  consoleFetchJSON
    .post('/api/proxy/plugin/oct-baremetal/discovery-service/api/v1/log', payload)
    .catch(() => {
      // Silently ignore — logging should never break user flow
    });
}

const dashboardLogger = {
  info: (action: string, message: string, details?: string) =>
    sendLog('INFO', action, message, details),

  warn: (action: string, message: string, details?: string) =>
    sendLog('WARN', action, message, details),

  error: (action: string, message: string, details?: string) =>
    sendLog('ERROR', action, message, details),
};

export default dashboardLogger;
