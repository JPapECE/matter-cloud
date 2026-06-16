/**
 * DatabaseService.ts
 * Cloud PostgreSQL Database Service
 */

import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export class DatabaseService {
  private pool: pg.Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("[DB] DATABASE_URL environment variable is missing.");
    }
    this.pool = new Pool({ connectionString });
  }

  public async init(): Promise<void> {
    console.log("[DB] Initializing PostgreSQL client pool...");
    await this.migrate();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. devices table
      await client.query(`
        CREATE TABLE IF NOT EXISTS devices (
          "nodeId"  TEXT        PRIMARY KEY,
          name      TEXT        NOT NULL,
          type      TEXT        NOT NULL DEFAULT 'unknown',
          "addedAt"   TIMESTAMPTZ NOT NULL,
          online    BOOLEAN     NOT NULL DEFAULT FALSE,
          "on"      BOOLEAN,
          level     SMALLINT
        );
      `);

      // Add on/level columns to existing deployments that pre-date this migration
      await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS "on" BOOLEAN`);
      await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS level SMALLINT`);

      // 2. device_capabilities table
      await client.query(`
        CREATE TABLE IF NOT EXISTS device_capabilities (
          "nodeId"            TEXT        PRIMARY KEY REFERENCES devices("nodeId") ON DELETE CASCADE,
          "supportsOnOff"     BOOLEAN     NOT NULL DEFAULT FALSE,
          "supportsLevel"     BOOLEAN     NOT NULL DEFAULT FALSE,
          "supportsColorTemp" BOOLEAN     NOT NULL DEFAULT FALSE,
          "supportsEnergy"    BOOLEAN     NOT NULL DEFAULT FALSE,
          "minMireds"         INTEGER,
          "maxMireds"         INTEGER,
          "minLevel"          INTEGER,
          "maxLevel"          INTEGER,
          "updatedAt"         TIMESTAMPTZ
        );
      `);

      // 3. energy_readings table
      await client.query(`
        CREATE TABLE IF NOT EXISTS energy_readings (
          id                       SERIAL      PRIMARY KEY,
          "nodeId"                   TEXT        NOT NULL REFERENCES devices("nodeId") ON DELETE CASCADE,
          "activePower"              REAL,
          voltage                  REAL,
          current                  REAL,
          "cumulativeEnergy"         REAL,
          "periodicEnergy"           REAL,
          "cumulativeEnergyExported" REAL,
          "periodicEnergyExported"   REAL,
          "recordedAt"               TIMESTAMPTZ NOT NULL
        );
      `);

      // 4. gateways registry table
      await client.query(`
        CREATE TABLE IF NOT EXISTS gateways (
          id           TEXT        PRIMARY KEY,
          "lastSeenAt" TIMESTAMPTZ NOT NULL
        );
      `);

      // 5. groups table
      await client.query(`
        CREATE TABLE IF NOT EXISTS groups (
          "groupId"   INTEGER     PRIMARY KEY,
          name      TEXT        NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL
        );
      `);

      // 6. group_members junction table
      await client.query(`
        CREATE TABLE IF NOT EXISTS group_members (
          "groupId" INTEGER NOT NULL REFERENCES groups("groupId") ON DELETE CASCADE,
          "nodeId"  TEXT    NOT NULL REFERENCES devices("nodeId") ON DELETE CASCADE,
          PRIMARY KEY ("groupId", "nodeId")
        );
      `);

      // Indexes
      await client.query(`CREATE INDEX IF NOT EXISTS idx_energy_readings_nodeid ON energy_readings("nodeId");`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_energy_readings_recordedat ON energy_readings("recordedAt" DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_group_members_nodeid ON group_members("nodeId");`);

      await client.query("COMMIT");
      console.log("[DB] Schema migrations applied successfully.");
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("[DB] Migration transaction failed:", err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Gateway state reconciliation ───────────────────────────────────────────

  public async reconcileFromGateway(devices: any[], groups: any[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      console.log(`[DB] Reconciling ${devices.length} devices and ${groups.length} groups from gateway...`);

      // 1. Reconcile devices
      // Keep existing devices, upsert properties. Set online=true for sync candidates.
      for (const d of devices) {
        await client.query(`
          INSERT INTO devices ("nodeId", name, type, "addedAt", online)
          VALUES ($1, $2, $3, $4, TRUE)
          ON CONFLICT ("nodeId") DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            online = TRUE
        `, [d.nodeId, d.name, d.type, d.addedAt]);
      }

      // Mark all other DB devices not present in sync payload as offline
      const deviceIds = devices.map(d => d.nodeId);
      if (deviceIds.length > 0) {
        await client.query(`
          UPDATE devices SET online = FALSE WHERE "nodeId" NOT IN (${deviceIds.map((_, i) => `$${i + 1}`).join(",")})
        `, deviceIds);
      } else {
        await client.query(`UPDATE devices SET online = FALSE`);
      }

      // 2. Reconcile groups (Truncate and reload as gateway is source of truth)
      await client.query(`DELETE FROM group_members`);
      await client.query(`DELETE FROM groups`);

      for (const g of groups) {
        await client.query(`
          INSERT INTO groups ("groupId", name, "createdAt")
          VALUES ($1, $2, NOW())
        `, [g.groupId, g.name]);

        for (const memberNodeId of g.members) {
          // Verify member device exists in cloud cache before mapping membership
          const devExists = await client.query(`SELECT 1 FROM devices WHERE "nodeId" = $1`, [memberNodeId]);
          if (devExists.rowCount && devExists.rowCount > 0) {
            await client.query(`
              INSERT INTO group_members ("groupId", "nodeId")
              VALUES ($1, $2)
              ON CONFLICT DO NOTHING
            `, [g.groupId, memberNodeId]);
          }
        }
      }

      await client.query("COMMIT");
      console.log("[DB] Reconciliation transaction completed.");
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("[DB] Reconciliation failed:", err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Devices & Capabilities ──────────────────────────────────────────────────

  public async getAllDevices(): Promise<any[]> {
    const res = await this.pool.query('SELECT * FROM devices ORDER BY "addedAt" ASC');
    return res.rows;
  }

  public async getDevice(nodeId: string): Promise<any | null> {
    const res = await this.pool.query('SELECT * FROM devices WHERE "nodeId" = $1', [nodeId]);
    return res.rows[0] || null;
  }

  public async updateDeviceOnlineStatus(nodeId: string, online: boolean): Promise<void> {
    await this.pool.query('UPDATE devices SET online = $1 WHERE "nodeId" = $2', [online, nodeId]);
  }

  public async updateDeviceOnOffState(nodeId: string, on: boolean): Promise<void> {
    await this.pool.query('UPDATE devices SET "on" = $1 WHERE "nodeId" = $2', [on, nodeId]);
  }

  public async updateDeviceLevelState(nodeId: string, level: number): Promise<void> {
    await this.pool.query('UPDATE devices SET level = $1 WHERE "nodeId" = $2', [level, nodeId]);
  }

  public async updateDeviceName(nodeId: string, name: string): Promise<void> {
    await this.pool.query('UPDATE devices SET name = $1 WHERE "nodeId" = $2', [name, nodeId]);
  }

  public async removeDevice(nodeId: string): Promise<void> {
    await this.pool.query('DELETE FROM devices WHERE "nodeId" = $1', [nodeId]);
  }

  public async saveDeviceCapabilities(caps: any): Promise<void> {
    const supportsOnOff = !!caps.hasOnOff;
    const supportsLevel = !!caps.hasLevelControl;
    const supportsColorTemp = !!caps.hasColorTemperature;
    const supportsEnergy = !!(caps.hasElectricalPower || caps.hasElectricalEnergy);

    const minMireds = caps.colorTempMaxKelvin ? Math.round(1000000 / caps.colorTempMaxKelvin) : null;
    const maxMireds = caps.colorTempMinKelvin ? Math.round(1000000 / caps.colorTempMinKelvin) : null;
    const minLevel = supportsLevel ? 1 : null;
    const maxLevel = supportsLevel ? 254 : null;

    await this.pool.query(`
      INSERT INTO device_capabilities ("nodeId", "supportsOnOff", "supportsLevel", "supportsColorTemp", "supportsEnergy", "minMireds", "maxMireds", "minLevel", "maxLevel", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT ("nodeId") DO UPDATE SET
        "supportsOnOff" = EXCLUDED."supportsOnOff",
        "supportsLevel" = EXCLUDED."supportsLevel",
        "supportsColorTemp" = EXCLUDED."supportsColorTemp",
        "supportsEnergy" = EXCLUDED."supportsEnergy",
        "minMireds" = EXCLUDED."minMireds",
        "maxMireds" = EXCLUDED."maxMireds",
        "minLevel" = EXCLUDED."minLevel",
        "maxLevel" = EXCLUDED."maxLevel",
        "updatedAt" = EXCLUDED."updatedAt"
    `, [caps.nodeId, supportsOnOff, supportsLevel, supportsColorTemp, supportsEnergy, minMireds, maxMireds, minLevel, maxLevel]);
  }

  public async getDeviceCapabilities(nodeId: string): Promise<any | null> {
    const res = await this.pool.query('SELECT * FROM device_capabilities WHERE "nodeId" = $1', [nodeId]);
    return res.rows[0] || null;
  }

  // ── Groups Cache ───────────────────────────────────────────────────────────

  public async getAllGroups(): Promise<any[]> {
    const res = await this.pool.query('SELECT * FROM groups ORDER BY "groupId" ASC');
    const result = [];
    for (const row of res.rows) {
      const membersRes = await this.pool.query('SELECT "nodeId" FROM group_members WHERE "groupId" = $1', [row.groupId]);
      result.push({
        ...row,
        members: membersRes.rows.map(r => r.nodeId),
      });
    }
    return result;
  }

  public async getGroup(groupId: number): Promise<any | null> {
    const res = await this.pool.query('SELECT * FROM groups WHERE "groupId" = $1', [groupId]);
    if (res.rowCount === 0) return null;
    const membersRes = await this.pool.query('SELECT "nodeId" FROM group_members WHERE "groupId" = $1', [groupId]);
    return {
      ...res.rows[0],
      members: membersRes.rows.map(r => r.nodeId),
    };
  }

  public async createGroup(groupId: number, name: string): Promise<void> {
    await this.pool.query('INSERT INTO groups ("groupId", name, "createdAt") VALUES ($1, $2, NOW()) ON CONFLICT ("groupId") DO UPDATE SET name = EXCLUDED.name', [groupId, name]);
  }

  public async deleteGroup(groupId: number): Promise<void> {
    await this.pool.query('DELETE FROM groups WHERE "groupId" = $1', [groupId]);
  }

  public async updateGroupName(groupId: number, name: string): Promise<void> {
    await this.pool.query('UPDATE groups SET name = $1 WHERE "groupId" = $2', [name, groupId]);
  }

  public async addGroupMember(groupId: number, nodeId: string): Promise<void> {
    await this.pool.query('INSERT INTO group_members ("groupId", "nodeId") VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, nodeId]);
  }

  public async removeGroupMember(groupId: number, nodeId: string): Promise<void> {
    await this.pool.query('DELETE FROM group_members WHERE "groupId" = $1 AND "nodeId" = $2', [groupId, nodeId]);
  }

  // ── Energy Readings ────────────────────────────────────────────────────────

  public async saveEnergyReading(nodeId: string, power: any, energy: any, recordedAt?: string): Promise<void> {
    const date = recordedAt ? new Date(recordedAt) : new Date();
    await this.pool.query(`
      INSERT INTO energy_readings ("nodeId", "activePower", voltage, current, "cumulativeEnergy", "periodicEnergy", "cumulativeEnergyExported", "periodicEnergyExported", "recordedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      nodeId,
      power?.activePower,
      power?.voltage,
      power?.current,
      energy?.cumulativeEnergy,
      energy?.periodicEnergy,
      energy?.cumulativeEnergyExported,
      energy?.periodicEnergyExported,
      date
    ]);
  }

  public async getEnergyHistory(nodeId: string, limit: number = 100, since?: string): Promise<any[]> {
    const clampedLimit = Math.min(limit, 1000);
    if (since) {
      const res = await this.pool.query(`
        SELECT * FROM energy_readings
        WHERE "nodeId" = $1 AND "recordedAt" > $2
        ORDER BY "recordedAt" DESC
        LIMIT $3
      `, [nodeId, new Date(since), clampedLimit]);
      return res.rows;
    } else {
      const res = await this.pool.query(`
        SELECT * FROM energy_readings
        WHERE "nodeId" = $1
        ORDER BY "recordedAt" DESC
        LIMIT $2
      `, [nodeId, clampedLimit]);
      return res.rows;
    }
  }

  public async getEnergyStats(nodeId: string, since: string): Promise<any> {
    const res = await this.pool.query(`
      SELECT
        AVG("activePower")  AS "avgPower",
        MAX("activePower")  AS "maxPower",
        MIN("activePower")  AS "minPower",
        COUNT(*)          AS "readingCount"
      FROM energy_readings
      WHERE "nodeId" = $1 AND "recordedAt" > $2 AND "activePower" IS NOT NULL
    `, [nodeId, new Date(since)]);
    const row = res.rows[0];
    return {
      avgPower: row?.avgPower ?? null,
      maxPower: row?.maxPower ?? null,
      minPower: row?.minPower ?? null,
      readingCount: parseInt(row?.readingCount || "0", 10),
    };
  }

  // ── Gateway connections ───────────────────────────────────────────────────

  public async saveGatewaySeen(id: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO gateways (id, "lastSeenAt")
      VALUES ($1, NOW())
      ON CONFLICT (id) DO UPDATE SET "lastSeenAt" = EXCLUDED."lastSeenAt"
    `, [id]);
  }

  public async isGatewayRegistered(id: string): Promise<boolean> {
    const res = await this.pool.query('SELECT 1 FROM gateways WHERE id = $1', [id]);
    return res.rowCount !== null && res.rowCount > 0;
  }
}

export const dbService = new DatabaseService();
