/**
 * McplServerRegistry — manages all connected MCPL server connections.
 *
 * Provides lookup by id, capability filtering, and feature set matching.
 */

import type { McplServerConfig, McplHostCapabilities } from './types.js';
import { McplServerConnection } from './server-connection.js';

/**
 * Capability keys that can be queried via `getServersWithCapability`.
 */
export type McplCapabilityQuery =
  | 'pushEvents'
  | 'contextHooks.beforeInference'
  | 'contextHooks.afterInference'
  | 'inferenceRequest'
  | 'modelInfo';

/**
 * Container that manages all connected MCPL servers.
 *
 * Provides methods to add/remove servers, look up by id, and query
 * servers by advertised capabilities or feature set names.
 */
export class McplServerRegistry {
  private servers = new Map<string, McplServerConnection>();

  /**
   * Connect to an MCPL server and register it.
   *
   * Throws if a server with the same id is already registered, or if
   * the connection/handshake fails.
   */
  async addServer(
    config: McplServerConfig,
    hostCapabilities: McplHostCapabilities,
  ): Promise<McplServerConnection> {
    if (this.servers.has(config.id)) {
      throw new Error(`MCPL server "${config.id}" is already registered`);
    }

    // Validate config: exactly one of command or url must be present
    if (!config.command && !config.url) {
      throw new Error(`MCPL server "${config.id}": either "command" (stdio) or "url" (WebSocket) must be provided`);
    }
    if (config.command && config.url) {
      throw new Error(`MCPL server "${config.id}": "command" and "url" are mutually exclusive`);
    }

    // Route to the appropriate transport
    let connection: McplServerConnection;
    if (config.reconnect) {
      connection = await McplServerConnection.connectWithReconnect(config, hostCapabilities);
    } else if (config.url) {
      connection = await McplServerConnection.connectWebSocket(config, hostCapabilities);
    } else {
      connection = await McplServerConnection.connect(config, hostCapabilities);
    }
    this.servers.set(config.id, connection);

    // Auto-remove on unexpected close (unless reconnect will re-add)
    connection.on('close', () => {
      if (!config.reconnect) {
        this.servers.delete(config.id);
      }
    });

    // Re-emit reconnect events for observability
    connection.on('reconnect', () => {
      // Connection already in the map — capabilities may have changed
    });

    return connection;
  }

  /**
   * Disconnect and remove a server by id.
   *
   * No-op if the server is not registered.
   */
  async removeServer(id: string): Promise<void> {
    const connection = this.servers.get(id);
    if (!connection) {
      return;
    }
    this.servers.delete(id);
    await connection.close();
  }

  /**
   * Get a server connection by id, or null if not found.
   */
  getServer(id: string): McplServerConnection | null {
    return this.servers.get(id) ?? null;
  }

  /**
   * Get all currently connected servers.
   */
  getAllServers(): McplServerConnection[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get all servers that advertise a specific capability.
   *
   * Supported capability queries:
   * - `'pushEvents'`                   — `capabilities.pushEvents === true`
   * - `'contextHooks.beforeInference'`  — `capabilities.contextHooks?.beforeInference === true`
   * - `'contextHooks.afterInference'`   — `capabilities.contextHooks?.afterInference` is truthy
   * - `'inferenceRequest'`              — `capabilities.inferenceRequest` is truthy
   * - `'modelInfo'`                     — `capabilities.modelInfo === true`
   */
  getServersWithCapability(cap: McplCapabilityQuery): McplServerConnection[] {
    return this.getAllServers().filter((server) => {
      const caps = server.capabilities;
      if (!caps) return false;

      switch (cap) {
        case 'pushEvents':
          return caps.pushEvents === true;
        case 'contextHooks.beforeInference':
          return caps.contextHooks?.beforeInference === true;
        case 'contextHooks.afterInference':
          return !!caps.contextHooks?.afterInference;
        case 'inferenceRequest':
          return !!caps.inferenceRequest;
        case 'modelInfo':
          return caps.modelInfo === true;
        default:
          return false;
      }
    });
  }

  /**
   * Get all servers that declare a feature set with the given name.
   *
   * Checks `capabilities.featureSets` for a key matching `featureSet`.
   */
  getServersForFeatureSet(featureSet: string): McplServerConnection[] {
    return this.getAllServers().filter((server) => {
      const caps = server.capabilities;
      if (!caps?.featureSets) return false;
      return featureSet in caps.featureSets;
    });
  }

  /**
   * Close all server connections and clear the registry.
   */
  async closeAll(): Promise<void> {
    const connections = Array.from(this.servers.values());
    this.servers.clear();
    await Promise.all(connections.map((c) => c.close()));
  }
}
