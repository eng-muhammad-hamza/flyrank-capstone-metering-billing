import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { config } from '../config';

export interface IDatabase {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  execute(sql: string, params?: any[]): Promise<{ changes: number }>;
  transaction<T>(fn: (db: IDatabase) => Promise<T>): Promise<T>;
  init(): Promise<void>;
  close(): Promise<void>;
}

class SQLiteDatabase implements IDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const fullPath = path.resolve(dbPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(fullPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } else {
      this.db = new DatabaseSync(':memory:');
    }
  }

  async init(): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(schemaSql);
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows as T[];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params: any[] = []): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return { changes: Number(result.changes) };
  }

  async transaction<T>(fn: (db: IDatabase) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDatabase implements IDatabase {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  private convertPlaceholders(sql: string): string {
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
  }

  async init(): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await this.pool.query(schemaSql);
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const pgSql = this.convertPlaceholders(sql);
    const result = await this.pool.query(pgSql, params);
    return result.rows as T[];
  }

  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql: string, params: any[] = []): Promise<{ changes: number }> {
    const pgSql = this.convertPlaceholders(sql);
    const result = await this.pool.query(pgSql, params);
    return { changes: result.rowCount || 0 };
  }

  async transaction<T>(fn: (db: IDatabase) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDb: IDatabase = {
        query: async (sql, params = []) => {
          const pgSql = this.convertPlaceholders(sql);
          const res = await client.query(pgSql, params);
          return res.rows;
        },
        queryOne: async (sql, params = []) => {
          const rows = await txDb.query(sql, params);
          return rows.length > 0 ? rows[0] : null;
        },
        execute: async (sql, params = []) => {
          const pgSql = this.convertPlaceholders(sql);
          const res = await client.query(pgSql, params);
          return { changes: res.rowCount || 0 };
        },
        transaction: async (innerFn) => innerFn(txDb),
        init: async () => {},
        close: async () => {},
      };
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(connectionUrl: string = config.databaseUrl): IDatabase {
  if (connectionUrl.startsWith('postgres://') || connectionUrl.startsWith('postgresql://')) {
    return new PostgresDatabase(connectionUrl);
  }
  const cleanPath = connectionUrl.replace(/^sqlite:/, '');
  return new SQLiteDatabase(cleanPath);
}

export const db: IDatabase = createDatabase();
