import { createSwRosterApi } from './sw-roster-api.mjs';
import { createSwRosterProjection } from './sw-roster-projection.mjs';
import { createSwRosterRegistry } from './sw-roster-registry.mjs';

export async function loadSwRoster({ z, Pool, pool, product, origins, supportsActivity, env = process.env }) {
  const url = env.SW_ROSTER_REGISTRY_URL;
  const invitationKey = env.SW_ROSTER_INVITATION_KEY;
  const readOnlyCanary = env.SW_ROSTER_READ_ONLY_CANARY === '1';
  const allowAdds = env.SW_ROSTER_ALLOW_ADDS === '1' && !readOnlyCanary;
  if (!url && !invitationKey && !allowAdds) {
    // A code rollback may disable additions, but existing managed learners must keep access checks.
    const { rows: [row] } = await pool.query("SELECT to_regclass('sw_roster.projection') IS NOT NULL AS installed");
    if (row.installed && (await pool.query('SELECT 1 FROM sw_roster.projection LIMIT 1')).rowCount) {
      throw new Error('SW_ROSTER_EXISTING_MEMBERS_REQUIRE_REGISTRY_CONFIG');
    }
    return null;
  }
  if (!url || !invitationKey || new URL(url).pathname !== '/sw_roster') {
    throw new Error('SW_ROSTER_REGISTRY_CONFIG_INVALID');
  }
  const registryPool = new Pool({
    connectionString: url, max: 4, connectionTimeoutMillis: 1500, statement_timeout: 4000,
    application_name: `sw_roster_${product}`,
  });
  registryPool.on('error', () => console.error(JSON.stringify({ event: 'sw_roster_registry_connection_error', product })));
  const registry = createSwRosterRegistry({ pool: registryPool, invitationKey });
  const projection = createSwRosterProjection({ pool, product });
  try {
    await Promise.all([
      pool.query('SELECT 1 FROM sw_roster.projection LIMIT 0'),
      registryPool.query('SELECT 1 FROM sw_roster.member,sw_roster.invitation,sw_roster.delivery LIMIT 0'),
    ]);
  } catch (error) {
    await registryPool.end();
    throw new Error(`SW_ROSTER_STORAGE_UNAVAILABLE:${error.code || 'CONNECTION_FAILED'}`);
  }
  const api = createSwRosterApi({
    z, product, registry, projection, allowedOrigins: origins, allowAdds, supportsActivity,
  });
  let interval;
  return {
    ...api,
    syncActivity: readOnlyCanary ? async () => {} : api.syncActivity,
    start() {
      if (readOnlyCanary) return;
      const sync = () => void api.runSweep().catch(err => console.warn(JSON.stringify({
        event: 'sw_roster_sweep_failed', product, code: err.code || 'SYNC_FAILED',
      })));
      sync();
      interval = setInterval(sync, 30_000);
      interval.unref();
    },
    async close() {
      clearInterval(interval);
      await registryPool.end();
    },
  };
}
