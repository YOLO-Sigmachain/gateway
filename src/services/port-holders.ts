/**
 * What start-up does about another process that already holds the Gateway port.
 *
 * By default nothing: Gateway does not stop other processes. If the port is busy, start-up
 * fails with a message naming the port. Setting GATEWAY_KILL_PORT_HOLDERS=true restores
 * the earlier behaviour, in which every process found on the port is killed first.
 */
export const KILL_PORT_HOLDERS_ENV = 'GATEWAY_KILL_PORT_HOLDERS';

/** Whether start-up should kill the processes holding the port. Only an explicit "true" says yes. */
export function killsPortHolders(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KILL_PORT_HOLDERS_ENV]?.trim().toLowerCase() === 'true';
}

/** Whether a listen error means the port is taken. */
export function isPortInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EADDRINUSE';
}

export function portInUseMessage(port: number | string): string {
  return (
    `Port ${port} is already in use by another process, so Gateway did not start. Stop that process or set ` +
    `another server.port. To have Gateway kill whatever holds the port at start-up instead, set ` +
    `${KILL_PORT_HOLDERS_ENV}=true.`
  );
}
